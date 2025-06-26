# Railway Deployment Guide

## Quick Deploy to Railway

### Option 1: Direct Deployment (Recommended)
1. Push your code to a GitHub repository
2. Go to [Railway.app](https://railway.app)
3. Click "Start a New Project"
4. Select "Deploy from GitHub repo"
5. Choose your repository
6. Railway will automatically detect it's a Node.js project and deploy

### Option 2: Railway CLI
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Initialize project
railway init

# Deploy
railway up
```

## Configuration

### Environment Variables (Auto-configured)
- `PORT` - Automatically set by Railway
- `NODE_ENV` - Set to "production" via railway.toml
- `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` - Set to "true"
- `PUPPETEER_EXECUTABLE_PATH` - Set to "/usr/bin/google-chrome-stable"

### Custom Environment Variables (Optional)
If you need to customize, add these in Railway dashboard:
- `BASE_DATA_DIR` - Directory for test data (default: ./server_data)

## Important Notes

### File Storage
- Railway uses **ephemeral storage** - files are deleted on restart
- Your test data in `server_data/` will be recreated on each deployment
- This is perfect for temporary visual regression test data

### Memory & Performance
- The app includes Puppeteer and BackstopJS which can be memory-intensive
- Consider upgrading to Railway Pro if you hit memory limits
- Default Railway plan should work for light to moderate usage

### Health Checks
- Health check endpoint: `/api/health`
- Railway will automatically monitor this endpoint
- Automatic restarts on failure (configured in railway.toml)

## Deployment Files Created

- `railway.toml` - Railway configuration
- `Dockerfile` - Container configuration with Chrome/Puppeteer
- `.env.example` - Environment variable documentation
- Updated `package.json` - Railway-compatible scripts

## Testing Your Deployment

1. After deployment, Railway will provide a URL (e.g., `https://your-app.railway.app`)
2. Test the health endpoint: `https://your-app.railway.app/api/health`
3. WebSocket endpoint: `wss://your-app.railway.app/ws`

## Troubleshooting

### Common Issues:
1. **Puppeteer fails**: The Dockerfile includes Chrome installation
2. **Memory issues**: Upgrade Railway plan or optimize Puppeteer settings
3. **File persistence**: Remember that files are ephemeral on Railway

### Logs:
```bash
# View logs with Railway CLI
railway logs
```

## Cost Optimization

- Railway charges based on usage
- Your app will sleep when inactive (free tier)
- Consider setting up monitoring to track usage

## Next Steps

1. Deploy to Railway
2. Test all functionality
3. Monitor performance and memory usage
4. Set up custom domain if needed (Railway Pro feature) 