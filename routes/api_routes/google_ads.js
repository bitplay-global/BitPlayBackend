// api_routes/google_ads.js
import express from "express";
import GoogleAds from '../../models/GoogleAds.js';

const router = express.Router();

router.get('/id/ios', async (req, res) => {
  try {
    const is_production = req.body.production;

    const ad_details = await GoogleAds.find().sort({ platform: "ios", production: is_production });
    res.status(200).json({ success: true, ad_details });
  } catch (err) {
    console.error('Error fetching subscription plans:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

router.get('/id/android', async (req, res) => {
  try {
    const ad_details = await GoogleAds.find().sort({ platform: "android", production: is_production });
    res.status(200).json({ success: true, ad_details });
  } catch (err) {
    console.error('Error fetching subscription plans:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

router.get('/ids', async (req, res) => {
  try {
    const { production } = req.query;
    const isProduction = production === 'true';

    console.log("GoogleAds Request!!", production);

    const adDocs = await GoogleAds.find({ production: isProduction }).lean();
    // console.log("GoogleAds - AdDocs", adDocs);

    const ads = {
      ios: {},
      android: {}
    };

    adDocs.forEach((ad) => {
      if (ad.ad_type === 'rewarded_video') {
        ads[ad.platform].rewardedVideoId = ad.ad_id;
      }
      if (ad.ad_type === 'home_banner') {
        ads[ad.platform].homeBannerId = ad.ad_id;
      }
      if (ad.ad_type === 'gam_rewarded_video') {
        ads[ad.platform].gamRewardedVideoId = ad.ad_id;
      }
      if (ad.ad_type === 'gam_home_banner') {
        ads[ad.platform].gamHomeBannerId = ad.ad_id;
      }
    });

    // console.log("GoogleAds - Ads: ", ads);

    res.status(200).json({ success: true, ads });
  } catch (err) {
    console.error('Error fetching Google Ads IDs:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

export default router;
