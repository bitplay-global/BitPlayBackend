import express from 'express';
import axios from 'axios';

const router = express.Router();

// Mobile backend URL (bitcoin_mining/backend server)
const MOBILE_BACKEND_URL = process.env.MOBILE_BACKEND_URL || 'http://localhost:5000';

// Proxy all requests to mobile backend
router.all('/*', async (req, res) => {
  try {
    // Remove /mobile_api prefix and keep the rest of the path
    const targetPath = req.originalUrl.replace('/mobile_api', '');
    const targetUrl = `${MOBILE_BACKEND_URL}${targetPath}`;

    console.log(`Proxying request: ${req.method} ${req.originalUrl} -> ${targetUrl}`);

    // Prepare request config
    const config = {
      method: req.method,
      url: targetUrl,
      headers: {
        ...req.headers,
        host: new URL(MOBILE_BACKEND_URL).host, // Update host header
      },
      data: req.body,
      params: req.query,
      validateStatus: () => true, // Don't throw on any status code
    };

    // Remove headers that shouldn't be forwarded
    delete config.headers['content-length'];
    delete config.headers['host'];

    // Make the proxied request
    const response = await axios(config);

    // Forward the response
    res.status(response.status);

    // Forward response headers (except some that shouldn't be forwarded)
    Object.keys(response.headers).forEach(key => {
      if (!['connection', 'transfer-encoding', 'content-encoding'].includes(key.toLowerCase())) {
        res.set(key, response.headers[key]);
      }
    });

    res.send(response.data);
  } catch (error) {
    console.error('Mobile API proxy error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Proxy error: Unable to reach mobile backend',
      error: error.message,
    });
  }
});

export default router;
