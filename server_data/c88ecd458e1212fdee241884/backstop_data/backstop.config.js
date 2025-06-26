module.exports = {
  "id": "visual_regression_test_c88ecd458e1212fdee241884",
  "viewports": [
    {
      "label": "phone",
      "width": 375,
      "height": 667
    },
    {
      "label": "tablet",
      "width": 1024,
      "height": 768
    },
    {
      "label": "desktop",
      "width": 1920,
      "height": 1080
    }
  ],
  "scenarios": [
    {
      "label": "home",
      "url": "https://hiring.staging.deeporion.com/",
      "referenceUrl": "https://hiring.staging.deeporion.com/",
      "selectors": [
        "document"
      ],
      "misMatchThreshold": 0.1,
      "requireSameDimensions": true,
      "waitForSelector": "body",
      "delay": 2000,
      "postInteractionWait": 1000
    }
  ],
  "paths": {
    "bitmaps_reference": "/home/dev/Desktop/dummy-visual-regression/backend/server_data/c88ecd458e1212fdee241884/backstop_data/bitmaps_reference",
    "bitmaps_test": "/home/dev/Desktop/dummy-visual-regression/backend/server_data/c88ecd458e1212fdee241884/backstop_data/bitmaps_test",
    "engine_scripts": "/home/dev/Desktop/dummy-visual-regression/backend/server_data/c88ecd458e1212fdee241884/backstop_data/engine_scripts",
    "html_report": "/home/dev/Desktop/dummy-visual-regression/backend/server_data/c88ecd458e1212fdee241884/backstop_data/html_report",
    "ci_report": "/home/dev/Desktop/dummy-visual-regression/backend/server_data/c88ecd458e1212fdee241884/backstop_data/ci_report"
  },
  "report": [
    "browser"
  ],
  "engine": "puppeteer",
  "engineOptions": {
    "args": [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  },
  "asyncCaptureLimit": 5,
  "asyncCompareLimit": 50,
  "debug": false,
  "openReport": false
};