# Media Upload Backend

Secure Node.js/Express backend for uploading media files to Cloudflare R2. This backend handles authentication via Firebase Admin SDK and securely manages R2 credentials.

## Architecture

```
Flutter App → Backend (this server) → Cloudflare R2
```

**Why this architecture?**
- ✅ R2 credentials never leave the server
- ✅ Firebase token verification ensures only authenticated users can upload
- ✅ File size and type validation prevents abuse
- ✅ Production-grade security

## Setup

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the `backend` directory:

```env
# Server Configuration
PORT=4000

# Firebase Admin SDK
# Option 1: Use environment variables (recommended for production)
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour private key here\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com

# Option 2: Download serviceAccountKey.json from Firebase Console
# Place it in the backend/ directory

# Cloudflare R2 Configuration
R2_ACCOUNT_ID=your-r2-account-id
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_BUCKET_NAME=localme
R2_PUBLIC_BASE_URL=https://your-public-r2-domain.com
```

### 3. Get Firebase Admin Credentials

**Option A: Environment Variables (Recommended)**
1. Go to Firebase Console > Project Settings > Service Accounts
2. Click "Generate new private key"
3. Copy the values:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `private_key` → `FIREBASE_PRIVATE_KEY` (keep the `\n` characters)
   - `client_email` → `FIREBASE_CLIENT_EMAIL`

**Option B: Service Account JSON File**
1. Download `serviceAccountKey.json` from Firebase Console
2. Place it in the `backend/` directory
3. **IMPORTANT:** Add `serviceAccountKey.json` to `.gitignore`!

### 4. Get R2 Credentials

1. Go to Cloudflare Dashboard > R2
2. Click "Manage R2 API Tokens"
3. Create a new API token with:
   - Permissions: Object Read & Write
   - Bucket: Your bucket name
4. Copy:
   - Account ID
   - Access Key ID
   - Secret Access Key

### 5. Configure R2 Public URL

You need a public URL to access uploaded files. Options:

**Option A: Custom Domain (Recommended)**
1. In R2, go to your bucket > Settings
2. Add a custom domain (e.g., `media.yourdomain.com`)
3. Set `R2_PUBLIC_BASE_URL=https://media.yourdomain.com`

**Option B: R2 Public URL**
1. Enable public access in R2 bucket settings
2. Use format: `https://pub-xxxxx.r2.dev`
3. Set `R2_PUBLIC_BASE_URL=https://pub-xxxxx.r2.dev`

## Running the Server

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

The server will start on `http://localhost:4000` (or your configured PORT).

## API Endpoints

### Health Check
```
GET /health
```

### Upload Profile Image
```
POST /api/upload/profile
Headers:
  Authorization: Bearer <Firebase_ID_Token>
Body (multipart/form-data):
  file: <image file>
  userId: <user_id>
  mediaType: "image"
  fileExtension: "jpg"
Response:
  { "url": "https://..." }
```

### Upload Post Media
```
POST /api/upload/post
Headers:
  Authorization: Bearer <Firebase_ID_Token>
Body (multipart/form-data):
  file: <image or video file>
  postId: <post_id>
  mediaType: "image" or "video"
  fileExtension: "jpg" or "mp4"
Response:
  { "url": "https://..." }
```

## Security Features

✅ **Firebase Token Verification** - Only authenticated users can upload  
✅ **File Size Limit** - Maximum 10MB per file  
✅ **Content Type Validation** - Prevents .exe files renamed as .jpg  
✅ **No Client-Side Secrets** - R2 keys never exposed to client  

## File Organization in R2

Files are organized as:
```
profiles/{userId}/{uuid}.{ext}
posts/{postId}/images/{uuid}.{ext}
posts/{postId}/videos/{uuid}.{ext}
```

## Troubleshooting

### "Firebase Admin initialization failed"
- Check your `.env` file formatting (must be multiline, not one line)
- Verify `FIREBASE_PRIVATE_KEY` includes `\n` characters
- Or use `serviceAccountKey.json` file instead

### "R2 upload failed"
- Verify all R2 credentials in `.env`
- Check bucket name matches `R2_BUCKET_NAME`
- Ensure R2 API token has correct permissions

### "Invalid file type"
- Only images (image/*) and videos (video/*) are allowed
- Check file extension matches actual file type

### Images don't load after upload
- Verify `R2_PUBLIC_BASE_URL` is correct
- Test URL in browser: should show image directly
- Check R2 bucket has public access enabled (if using public URL)

## Deployment

### Render / Railway / VPS

1. Set environment variables in your hosting platform
2. Make sure `PORT` is set (Render/Railway auto-assign, use `process.env.PORT`)
3. Deploy and update Flutter app with production URL

### Example Render Setup
```bash
# Build command (not needed for Node.js)
# Start command
npm start
```

Update Flutter `MediaUploadService._baseUrl` to your production URL.

## Next Steps

- [ ] Add rate limiting (prevent abuse)
- [ ] Add image compression/resizing
- [ ] Implement signed URLs for private files
- [ ] Add CDN integration
- [ ] Set up monitoring/logging

