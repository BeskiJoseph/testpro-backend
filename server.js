import express from 'express';
import multer from 'multer';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import admin from 'firebase-admin';
import crypto from 'crypto';
import { readFileSync, readdirSync, accessSync, constants } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
// Render injects these automatically, but for local dev we use dotenv
dotenv.config();

if (process.env.NODE_ENV !== 'production' && !process.env.FIREBASE_PROJECT_ID) {
  console.warn('⚠️  Warning: Environment variables might be missing.');
} else {
  console.log('✅ Environment check passed');
}

const app = express();
const PORT = process.env.PORT || 4000;

// ============================================
// Firebase Admin Initialization
// ============================================
// Option 1: Using environment variables (REQUIRED for production)
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('✅ Firebase Admin initialized from environment variables');
  } catch (error) {
    console.error('❌ Firebase Admin initialization failed:', error.message);
    process.exit(1);
  }
} else {
  console.error('❌ Missing Firebase environment variables (FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL)');
  console.error('   For security regions, file-based service accounts are disabled in this version.');
  process.exit(1);
}

// ============================================
// R2/S3 Client Initialization
// ============================================
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'localme';
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

// Debug: Show which R2 variables are loaded (without showing secrets)
console.log('\n📋 Environment Variables Status:');
console.log(`   R2_ACCOUNT_ID: ${process.env.R2_ACCOUNT_ID ? '✅ Set' : '❌ Missing'}`);
console.log(`   R2_ACCESS_KEY_ID: ${process.env.R2_ACCESS_KEY_ID ? '✅ Set' : '❌ Missing'}`);
console.log(`   R2_SECRET_ACCESS_KEY: ${process.env.R2_SECRET_ACCESS_KEY ? '✅ Set' : '❌ Missing'}`);
console.log(`   R2_BUCKET_NAME: ${R2_BUCKET_NAME}`);
console.log(`   R2_PUBLIC_BASE_URL: ${R2_PUBLIC_BASE_URL || '❌ Not set'}`);
console.log(`   PORT: ${PORT}\n`);

if (!R2_PUBLIC_BASE_URL) {
  console.warn('⚠️  R2_PUBLIC_BASE_URL not set. Uploads will work but URLs may be incorrect.');
}

// ============================================
// Middleware
// ============================================

// Security Headers
app.use(helmet());

// Logging
app.use(morgan('combined'));

// Rate Limiting (100 requests per 15 minutes)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// CORS
// Allow configuration via environment variable, default to allowing all (for dev) mostly,
// but for production it's better to be specific.
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Multer configuration with file size limit (10MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

// ============================================
// Authentication Middleware
// ============================================
async function verifyFirebaseToken(req, res, next) {
  try {
    if (process.env.NODE_ENV !== 'production') {
      console.log('🔐 Verifying Firebase token...');
    }
    const authHeader = req.headers.authorization;
    console.log('   Auth header:', authHeader ? 'Present' : 'Missing');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('❌ Missing or invalid Authorization header');
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    console.log('✅ Token verified for user:', decodedToken.uid);

    // Attach user info to request
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
    };

    next();
  } catch (error) {
    console.error('❌ Token verification failed:', error.message);
    return res.status(401).json({ error: 'Invalid or expired token: ' + error.message });
  }
}

// ============================================
// Helper: Upload file to R2
// ============================================
async function uploadToR2(file, key, contentType) {
  try {
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: contentType,
      // Make file publicly readable (adjust based on your needs)
      // For private files, remove this and use signed URLs instead
      // ACL: 'public-read', // R2 doesn't support ACL, files are public if bucket is public
    });

    await r2Client.send(command);

    // Construct public URL
    const publicUrl = R2_PUBLIC_BASE_URL
      ? `${R2_PUBLIC_BASE_URL}/${key}`
      : `https://${R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`;

    return publicUrl;
  } catch (error) {
    console.error('R2 upload error:', error);
    throw new Error(`Failed to upload to R2: ${error.message}`);
  }
}

// ============================================
// Helper: Get Extension from MimeType
// ============================================
function getExtensionFromMimeType(mimetype) {
  const mimeMap = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
  };
  return mimeMap[mimetype] || null;
}

// ============================================
// Helper: Validate file type
// ============================================
function validateMediaType(mimetype, expectedMediaType) {
  if (expectedMediaType === 'image') {
    return mimetype.startsWith('image/');
  } else if (expectedMediaType === 'video') {
    return mimetype.startsWith('video/');
  }
  return false;
}

// ============================================
// Routes
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Upload profile image
app.post('/api/upload/profile', verifyFirebaseToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // STRICT: Ignore userId from body. Use authenticated uid.
    const userId = req.user.uid;

    // STRICT: Derive extension from MIME type. Ignore client extension.
    const ext = getExtensionFromMimeType(req.file.mimetype);
    if (!ext) {
      return res.status(400).json({ error: 'Unsupported file type: ' + req.file.mimetype });
    }

    // Validate media type (must be image for profile)
    if (!validateMediaType(req.file.mimetype, 'image')) {
      return res.status(400).json({ error: 'Invalid file type. Only images are allowed for profiles.' });
    }

    // Generate unique key for R2
    // Path: profiles/{uid}/{uuid}.{ext}
    const key = `profiles/${userId}/${crypto.randomUUID()}.${ext}`;

    // Upload to R2
    const publicUrl = await uploadToR2(req.file, key, req.file.mimetype);

    // Log successful upload
    console.log(`✅ User ${userId} uploaded profile image: ${key}`);

    res.json({ url: publicUrl });
  } catch (error) {
    console.error('Profile upload error:', error);
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// Upload post media (image or video)
app.post('/api/upload/post', verifyFirebaseToken, upload.single('file'), async (req, res) => {
  try {
    console.log('📥 Upload request received');
    console.log('   User:', req.user?.uid);
    console.log('   File:', req.file?.originalname, 'Size:', req.file?.size);

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { mediaType, postId } = req.body; // We still take mediaType to know intent, but we verify it.

    // Validate media type
    if (mediaType !== 'image' && mediaType !== 'video') {
      return res.status(400).json({ error: 'Media type must be "image" or "video"' });
    }

    // Validate mime matches intent
    if (!validateMediaType(req.file.mimetype, mediaType)) {
      return res.status(400).json({
        error: `Invalid file type. Expected ${mediaType}, got ${req.file.mimetype}`
      });
    }

    // STRICT: Derive extension
    const ext = getExtensionFromMimeType(req.file.mimetype);
    if (!ext) {
      return res.status(400).json({ error: 'Unsupported file type: ' + req.file.mimetype });
    }

    // Generate unique key for R2
    // Path: posts/{uid}/{postId?}/{type}/{uuid}.{ext}
    // We include uid in the path to enforce ownership/namespaces even if they supply a postId.
    const userFolder = req.user.uid;
    const postFolder = postId ? postId : 'uncategorized';
    const typeFolder = mediaType === 'video' ? 'videos' : 'images';

    const key = `posts/${userFolder}/${postFolder}/${typeFolder}/${crypto.randomUUID()}.${ext}`;

    console.log('⬆️  Uploading to R2:', key);

    // Upload to R2
    const publicUrl = await uploadToR2(req.file, key, req.file.mimetype);

    console.log('✅ Upload successful:', publicUrl);

    res.json({ url: publicUrl });
  } catch (error) {
    console.error('Post upload error:', error);
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// Error handler for multer file size limit
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
  }
  next(error);
});

// ============================================
// Media Proxy (Solves Client SSL/CORS Issues)
// ============================================
app.get('/api/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).json({ error: 'URL parameter missing' });
    }

    console.log(`🔗 Proxying: ${targetUrl}`);

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(targetUrl);

    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch media: ${response.statusText}`);
    }

    // Forward Headers
    res.setHeader('Content-Type', response.headers.get('content-type'));
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year

    // Pipe data
    response.body.pipe(res);

  } catch (error) {
    console.error('Proxy failed:', error);
    res.status(500).end();
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global Error Handler (Production Best Practice)
app.use((err, req, res, next) => {
  console.error('🔥 Unhandled error:', err);

  // Don't leak stack traces in production
  const isProd = process.env.NODE_ENV === 'production';

  res.status(500).json({
    error: 'Internal server error',
    message: isProd ? undefined : err.message, // Only show details in dev
    requestId: crypto.randomUUID(),
  });
});

// ============================================
// Start Server
// ============================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`   Local: http://localhost:${PORT}`);
  console.log(`   Android Emulator: http://10.0.2.2:${PORT}`);
  console.log(`   Same Network: http://192.168.1.10:${PORT}`);
  console.log(`📁 R2 Bucket: ${R2_BUCKET_NAME}`);
  console.log(`🌐 Public URL Base: ${R2_PUBLIC_BASE_URL || 'Not configured'}`);
  console.log(`\n📝 Endpoints:`);
  console.log(`   GET  /health`);
  console.log(`   POST /api/upload/profile`);
  console.log(`   POST /api/upload/post`);
});

