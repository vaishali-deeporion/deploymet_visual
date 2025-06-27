const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const multer = require('multer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const cors = require('cors');
const WebSocket = require('ws');

// Base configuration
const BASE_DATA_DIR = process.env.BASE_DATA_DIR || './server_data';

// Puppeteer configuration for Railway deployment - optimized for low resources
const PUPPETEER_CONFIG = {
    headless: 'new',
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
        '--memory-pressure-off',
        '--max_old_space_size=512',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images',
        '--disable-javascript',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-web-resources'
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    timeout: 60000,
    // Reduce memory usage
    defaultViewport: { width: 1024, height: 768 },
    // Limit concurrent processes
    pipe: true
};

// Test environment management
const activeTestEnvironments = new Map();
const wsClients = new Map(); // socketId -> { ws, subscriptions, lastPing }

// Global browser instance management
let globalBrowser = null;
let browserLaunchPromise = null;
let activeBrowserSessions = 0;
const MAX_CONCURRENT_SESSIONS = 1; // Limit to 1 concurrent session

// Ensure base directory exists
if (!fs.existsSync(BASE_DATA_DIR)) {
    fs.mkdirSync(BASE_DATA_DIR, { recursive: true });
}

const app = express();
const http = require('http').createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ 
    server: http,
    path: '/ws'
});

// Enable CORS
app.use(cors({
    origin: "*"
}));

app.use(bodyParser.json());

// Health check endpoint for Railway
app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        activeTests: activeTestEnvironments.size
    });
});

// Test Chrome/Puppeteer endpoint
app.get('/api/test-chrome', async (req, res) => {
    let browser = null;
    let page = null;
    
    try {
        console.log('🔍 Testing Chrome via API endpoint...');
        browser = await getBrowserInstance();
        page = await browser.newPage();
        await page.setViewport({ width: 1024, height: 768 });
        await page.goto('https://example.com', { waitUntil: 'networkidle2', timeout: 30000 });
        const title = await page.title();
        
        res.json({
            status: 'success',
            message: 'Chrome/Puppeteer is working',
            testUrl: 'https://example.com',
            pageTitle: title,
            chromeExecutable: process.env.PUPPETEER_EXECUTABLE_PATH,
            activeSessions: activeBrowserSessions,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Chrome test failed:', error);
        res.status(500).json({
            status: 'failed',
            error: error.message,
            chromeExecutable: process.env.PUPPETEER_EXECUTABLE_PATH,
            activeSessions: activeBrowserSessions,
            timestamp: new Date().toISOString()
        });
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (error) {
                console.error('Error closing page:', error);
            }
        }
        releaseBrowserSession();
    }
});

// Serve static files from test environments
app.use('/backstop_data/:testId', (req, res, next) => {
    const testId = req.params.testId;
    const testEnv = activeTestEnvironments.get(testId);
    
    if (testEnv) {
        express.static(testEnv.backstopDataDir)(req, res, next);
    } else {
        res.status(404).json({ error: 'Test environment not found' });
    }
});

// Create a new test environment
function createTestEnvironment() {
    const testId = crypto.randomBytes(12).toString('hex');
    const testDataDir = path.join(BASE_DATA_DIR, testId);
    const backstopDataDir = path.join(testDataDir, 'backstop_data');
    const uploadsDir = path.join(testDataDir, 'uploads');
    
    // Create directories
    [testDataDir, backstopDataDir, uploadsDir].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
    
    const testEnv = {
        testId,
        testDataDir,
        backstopDataDir,
        uploadsDir,
        isRunning: false,
        createdAt: new Date(),
        lastActivity: new Date(),
        lastUploadedExcel: null
    };
    
    activeTestEnvironments.set(testId, testEnv);
    
    return testEnv;
}

// Clean up inactive test environments
function cleanupInactiveEnvironments() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    for (const [testId, testEnv] of activeTestEnvironments.entries()) {
        if (testEnv.lastActivity < oneHourAgo) {            
            if (fs.existsSync(testEnv.testDataDir)) {
                fs.rmSync(testEnv.testDataDir, { recursive: true, force: true });
            }
            
            activeTestEnvironments.delete(testId);
        }
    }
}

// Run cleanup every 30 minutes
setInterval(cleanupInactiveEnvironments, 30 * 60 * 1000);

// Enhanced logging function - broadcasts logs only to clients subscribed to the specific testId
function logMessage(testId, message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const emoji = {
        'info': 'ℹ️',
        'success': '✅',
        'warning': '⚠️',
        'error': '❌'
    };
    
    const logData = {
        message,
        timestamp: new Date().toISOString(),
        testId,
        logType: type,
        formatted: `[${testId}] [${timestamp}] ${emoji[type] || 'ℹ️'} ${message}`
    };
    
    const testEnv = activeTestEnvironments.get(testId);
    if (testEnv) {
        testEnv.lastActivity = new Date();
    }
    
    broadcastToTestClients(testId, {
        type: 'log',
        data: logData
    });
}

// Broadcast message to all connected WebSocket clients (for server-level messages)
function broadcastToAllClients(messageObj) {
    wsClients.forEach((clientInfo, socketId) => {
        if (clientInfo.ws.readyState === WebSocket.OPEN) {
            try {
                clientInfo.ws.send(JSON.stringify(messageObj));
            } catch (error) {
                console.error(`Failed to send message to client ${socketId}:`, error);
                // Remove dead connection
                wsClients.delete(socketId);
            }
        } else {
            // Remove dead connection
            wsClients.delete(socketId);
        }
    });
}

// Broadcast to clients subscribed to specific testId (proper filtering)
// Broadcast to clients subscribed to specific testId ONLY (no "all" subscription)
function broadcastToTestClients(testId, messageObj) {
    console.log(`Broadcasting to testId: ${testId}, message type: ${messageObj.type}`);
    
    let sentCount = 0;
    wsClients.forEach((clientInfo, socketId) => {
        if (clientInfo.ws.readyState === WebSocket.OPEN) {
            // ONLY send to clients specifically subscribed to this testId
            // Remove "all" subscription logic to prevent cross-contamination
            const isSubscribed = clientInfo.subscriptions.includes(testId);
            
            if (isSubscribed) {
                try {
                    clientInfo.ws.send(JSON.stringify(messageObj));
                    sentCount++;
                    console.log(`Sent message to client ${socketId} (subscribed to ${testId})`);
                } catch (error) {
                    console.error(`Failed to send message to client ${socketId}:`, error);
                    wsClients.delete(socketId);
                }
            } else {
                console.log(`Skipped client ${socketId} (subscriptions: ${clientInfo.subscriptions.join(", ")})`);
            }
        } else {
            wsClients.delete(socketId);
        }
    });
    
    console.log(`Broadcast complete: sent to ${sentCount} clients for testId ${testId}`);
}

// Enhanced status and progress tracking functions
function emitStatus(testId, status, message, data = {}) {
    const statusData = {
        testId,
        status, // 'started', 'crawling', 'generating-config', 'creating-reference', 'running-test', 'completed', 'error'
        message,
                        timestamp: new Date().toISOString(),
        ...data
    };
    
    broadcastToTestClients(testId, {
        type: 'status',
        data: statusData
    });
    
    // Also log the status
    logMessage(testId, message, status === 'error' ? 'error' : 'info');
}

function emitStepProgress(testId, step, current, total, message = '') {
    const progressData = {
                        testId,
        step, // 'crawling', 'reference', 'testing', 'processing'
        current,
        total,
        percentage: Math.round((current / total) * 100),
        message,
        timestamp: new Date().toISOString()
    };
    
    broadcastToTestClients(testId, {
        type: 'step-progress',
        data: progressData
    });
}

function emitProgress(testId, current, total) {
    broadcastToTestClients(testId, {
        type: 'progress',
        data: { current, total, testId, timestamp: new Date().toISOString() }
    });
}

function emitComplete(testId, reportPath) {
    broadcastToTestClients(testId, {
                    type: 'complete',
                    data: {
                        reportUrl: reportPath,
                        timestamp: new Date().toISOString(),
            testId
        }
    });
}

function emitError(testId, error) {
    broadcastToTestClients(testId, {
        type: 'error',
                    data: {
            error: typeof error === 'string' ? error : error.message,
            timestamp: new Date().toISOString(),
            testId
        }
    });
}

// Clear existing BackstopJS data
function clearBackstopData(testEnv) {
    const dirsToClean = [
        path.join(testEnv.backstopDataDir, 'bitmaps_reference'),
        path.join(testEnv.backstopDataDir, 'bitmaps_test'),
        path.join(testEnv.backstopDataDir, 'html_report')
    ];
    
    dirsToClean.forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        fs.mkdirSync(dir, { recursive: true });
    });
}

// Function to load and scroll through a page to ensure all content is loaded
async function loadAndScrollPage(scenario) {
    let browser = null;
    let page = null;
    
    try {
        console.log(`Processing URL: ${scenario.url}`);
        browser = await getBrowserInstance();
        page = await browser.newPage();
        
        // Set a smaller viewport to reduce memory usage
        await page.setViewport({ width: 1024, height: 768 });
        
        await page.goto(scenario.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { visible: true, timeout: 60000 });
        
        // Simplified scrolling to reduce resource usage
        await page.evaluate(async () => {
            const scrollStep = 200;
            const delay = 100;
            const pageHeight = document.body.scrollHeight;
            const totalSteps = Math.min(Math.round(pageHeight / scrollStep), 10); // Limit scrolling
            
            for (let i = 0; i < totalSteps; i++) {
                window.scrollBy(0, scrollStep);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            // Scroll back to the top
            window.scrollTo(0, 0);
        });
        
        console.log('Scrolling completed');
        return { url: scenario.url, status: 'success' };
    } catch (error) {
        console.error(`Error processing URL: ${scenario.url}`, error);
        return { url: scenario.url, status: 'failed', error: error.message };
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (error) {
                console.error('Error closing page:', error);
            }
        }
        releaseBrowserSession();
    }
}

// Enhanced BackstopJS process runner with detailed progress tracking
function runBackstopCommand(command, configPath, testId, onComplete) {
    console.log(`🚀 Starting BackstopJS ${command} for testId: ${testId}`);
    console.log(`📁 Config path: ${configPath}`);
    console.log(`🔧 Chrome executable: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    
    const childProcess = spawn('npx', ['backstop', command, `--config=${configPath}`], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        env: {
            ...process.env,
            PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH
        }
    });
    
    let output = '';
    let errorOutput = '';
    let currentStep = 0;
    let totalSteps = 0;
    
    // Emit that the BackstopJS command has started
    emitStatus(testId, command === 'reference' ? 'creating-reference' : 'running-test', 
               `Starting BackstopJS ${command}...`);
    
    // Stream stdout - send filtered output to WebSocket
    childProcess.stdout.on('data', (data) => {
        const message = data.toString();
        output += message;
        console.log(`[${testId}] BackstopJS stdout:`, message.trim());
        
        // Parse BackstopJS output for progress information
        const lines = message.split('\n').filter(line => line.trim());
        lines.forEach(line => {
            if (line.trim()) {
                // Look for progress indicators in BackstopJS output
                if (line.includes('Setting up')) {
                    emitStatus(testId, 'processing', `Setting up: ${line.trim()}`);
                } else if (line.includes('Capturing')) {
                    // Parse scenario progress
                    const scenarioMatch = line.match(/(\d+).*?(\d+)/);
                    if (scenarioMatch) {
                        const current = parseInt(scenarioMatch[1]);
                        const total = parseInt(scenarioMatch[2]);
                        emitStepProgress(testId, command, current, total, `Capturing scenario ${current} of ${total}`);
                    }
                    emitStatus(testId, 'processing', `Capturing: ${line.trim()}`);
                } else if (line.includes('Comparing')) {
                    const compareMatch = line.match(/(\d+).*?(\d+)/);
                    if (compareMatch) {
                        const current = parseInt(compareMatch[1]);
                        const total = parseInt(compareMatch[2]);
                        emitStepProgress(testId, 'comparing', current, total, `Comparing scenario ${current} of ${total}`);
                    }
                    emitStatus(testId, 'processing', `Comparing: ${line.trim()}`);
                } else if (line.includes('report')) {
                    emitStatus(testId, 'generating-report', `Generating report: ${line.trim()}`);
                } else if (line.includes('PASS') || line.includes('SUCCESS')) {
                    emitStatus(testId, 'success', `Success: ${line.trim()}`);
                } else if (line.includes('FAIL') || line.includes('ERROR')) {
                    emitStatus(testId, 'warning', `Warning: ${line.trim()}`);
                } else {
                    // General BackstopJS output
                    logMessage(testId, `BackstopJS ${command}: ${line.trim()}`);
                }
            }
        });
    });
    
    // Stream stderr - send filtered errors to WebSocket
    childProcess.stderr.on('data', (data) => {
        const error = data.toString();
        errorOutput += error;
        console.error(`[${testId}] BackstopJS stderr:`, error.trim());
        
        const lines = error.split('\n').filter(line => line.trim());
        lines.forEach(line => {
            if (line.trim()) {
                emitStatus(testId, 'error', `Error: ${line.trim()}`);
                logMessage(testId, `BackstopJS ${command} stderr: ${line.trim()}`, 'error');
            }
        });
    });
    
    childProcess.on('close', (code) => {
        const statusMessage = `BackstopJS ${command} completed with exit code: ${code}`;
        console.log(`[${testId}] ${statusMessage}`);
        console.log(`[${testId}] Full stdout:`, output);
        console.log(`[${testId}] Full stderr:`, errorOutput);
        
        if (code === 0) {
            emitStatus(testId, 'success', statusMessage);
        } else if (code === 1 && command === 'test') {
            // Exit code 1 for test command usually means differences found (not an error)
            emitStatus(testId, 'completed-with-differences', 'Test completed - visual differences detected');
        } else {
            emitStatus(testId, 'error', `Command failed: ${statusMessage}`);
            logMessage(testId, `BackstopJS Error Details - stdout: ${output}`, 'error');
            logMessage(testId, `BackstopJS Error Details - stderr: ${errorOutput}`, 'error');
        }
        
        logMessage(testId, statusMessage);
        onComplete(code, output, errorOutput);
    });
    
    // Handle process timeout
    const timeout = setTimeout(() => {
        childProcess.kill('SIGTERM');
        emitStatus(testId, 'error', `BackstopJS ${command} process timed out`);
        logMessage(testId, `BackstopJS ${command} process timed out`, 'error');
        emitError(testId, `${command} process timed out`);
    }, 300000); // 5 minutes timeout
    
    childProcess.on('close', () => {
        clearTimeout(timeout);
    });
    
    return childProcess;
}

// Enhanced fetchAllRoutes with detailed progress updates
async function fetchAllRoutes(url, testId) {
    try {
        const baseUrl = url.replace(/\/$/, '');
        const baseUrlObj = new URL(baseUrl);
        const foundRoutes = new Set(['/']);
        const visited = new Set();
        const toVisit = new Set(['/']);
        
        emitStatus(testId, 'crawling', 'Starting website crawl to discover routes...');
        logMessage(testId, 'Starting to crawl website for routes...');
        
        const browser = await puppeteer.launch(PUPPETEER_CONFIG);
        
        let pageCount = 0;
        const MAX_PAGES = 50;
        
        while (toVisit.size > 0 && visited.size < MAX_PAGES && pageCount < MAX_PAGES) {
            const currentPath = Array.from(toVisit)[0];
            toVisit.delete(currentPath);
            
            if (visited.has(currentPath)) continue;
            visited.add(currentPath);
            pageCount++;
            
            // Send crawling progress
            emitStepProgress(testId, 'crawling', pageCount, Math.min(MAX_PAGES, toVisit.size + pageCount), 
                           `Crawling page ${pageCount}: ${currentPath}`);
            
            try {
                const fullUrl = baseUrl + currentPath;
                emitStatus(testId, 'crawling', `Analyzing page: ${fullUrl}`);
                logMessage(testId, `Crawling (${pageCount}/${MAX_PAGES}): ${fullUrl}`);
                
                const page = await browser.newPage();
                await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
                
                const links = await page.evaluate(() => {
                    const anchors = document.querySelectorAll('a[href]');
                    return Array.from(anchors).map(a => a.href);
                });
                
                await page.close();
                
                let newRoutesFound = 0;
                for (const link of links) {
                    try {
                        const linkUrl = new URL(link);
                        
                        if (linkUrl.hostname !== baseUrlObj.hostname) continue;
                        
                        let pathname = linkUrl.pathname;
                        if (!pathname.startsWith('/')) pathname = '/' + pathname;
                        
                        if (pathname.match(/\.(jpg|jpeg|png|gif|css|js|ico|xml|pdf|doc|docx|txt)$/i)) continue;
                        if (visited.has(pathname) || foundRoutes.has(pathname)) continue;
                        
                        foundRoutes.add(pathname);
                        newRoutesFound++;
                        if (toVisit.size < 50) {
                            toVisit.add(pathname);
                        }
                    } catch (e) {
                        continue;
                    }
                }
                
                if (newRoutesFound > 0) {
                    emitStatus(testId, 'crawling', `Found ${newRoutesFound} new routes on this page. Total: ${foundRoutes.size}`);
                }
                
            } catch (error) {
                emitStatus(testId, 'warning', `Error crawling ${currentPath}: ${error.message}`);
                logMessage(testId, `Error crawling ${currentPath}: ${error.message}`, 'error');
                continue;
            }
        }
        
        await browser.close();
        
        const routes = Array.from(foundRoutes);
        emitStatus(testId, 'crawling-complete', `Crawling complete! Found ${routes.length} routes to test`);
        logMessage(testId, `Found ${routes.length} routes`);
        return routes;
        
    } catch (error) {
        emitStatus(testId, 'error', `Error during crawling: ${error.message}`);
        logMessage(testId, `Error in fetchAllRoutes: ${error.message}`, 'error');
        return ['/'];
    }
}

// Generate BackstopJS config
function generateBackstopConfig(prodUrl, stagingUrl, routes, testEnv) {
    const cleanProdUrl = prodUrl.replace(/\/$/, '');
    const cleanStagingUrl = stagingUrl.replace(/\/$/, '');

    const scenarios = routes.map(route => ({
        label: route === '/' ? 'home' : route.replace(/[^a-zA-Z0-9]/g, '_'),
        url: cleanProdUrl + route,
        referenceUrl: cleanStagingUrl + route,
        selectors: ["document"],
        misMatchThreshold: 0.1,
        requireSameDimensions: true,
        waitForSelector: 'body',
        delay: 3000,
        postInteractionWait: 2000
    }));

    return {
        id: `visual_regression_test_${testEnv.testId}`,
        viewports: [
            { label: "desktop", width: 1024, height: 768 } // Only one viewport to save resources
        ],
        scenarios,
        paths: {
            bitmaps_reference: path.resolve(testEnv.backstopDataDir, 'bitmaps_reference'),
            bitmaps_test: path.resolve(testEnv.backstopDataDir, 'bitmaps_test'),
            engine_scripts: path.resolve(testEnv.backstopDataDir, 'engine_scripts'),
            html_report: path.resolve(testEnv.backstopDataDir, 'html_report'),
            ci_report: path.resolve(testEnv.backstopDataDir, 'ci_report')
        },
        report: ["browser"],
        engine: "puppeteer",
        engineOptions: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-web-security",
                "--disable-features=VizDisplayCompositor",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--memory-pressure-off",
                "--max_old_space_size=512",
                "--disable-extensions",
                "--disable-plugins",
                "--disable-images",
                "--disable-default-apps"
            ]
        },
        asyncCaptureLimit: 1, // Only 1 concurrent capture
        asyncCompareLimit: 1,  // Only 1 concurrent comparison
        debug: true,
        debugWindow: false,
        openReport: false
    };
}

// API Routes

// Create test environment
app.post('/api/create-environment', (req, res) => {
    const testEnv = createTestEnvironment();
    res.json({
        testId: testEnv.testId,
        message: 'Test environment created successfully'
    });
});

// Enhanced test endpoint with detailed status updates
app.post('/api/test', async (req, res) => {
    const testEnv = createTestEnvironment();
    
    if (testEnv.isRunning) {
        return res.status(429).json({ 
            error: 'A test is already running in this environment',
            testId: testEnv.testId
        });
    }
    testEnv.isRunning = true;
    
    try {
        const { prodUrl, stagingUrl } = req.body;
        
        if (!prodUrl || !stagingUrl) {
            testEnv.isRunning = false;
            return res.status(400).json({ error: 'Both production and staging URLs are required' });
        }

        // Step 1: Test started
        emitStatus(testEnv.testId, 'started', `Visual regression test started: ${prodUrl} vs ${stagingUrl}`);
        logMessage(testEnv.testId, `Starting visual regression test: ${prodUrl} vs ${stagingUrl}`);

        // Step 2: Clear existing data
        emitStatus(testEnv.testId, 'preparing', 'Preparing test environment...');
        clearBackstopData(testEnv);
        
        // Step 3: Find routes
        emitStatus(testEnv.testId, 'crawling', 'Discovering website routes...');
        const routes = await fetchAllRoutes(prodUrl, testEnv.testId);
        const routesToTest = routes.slice(0, 20); // Limit routes
        
        // Step 3.5: Pre-load and scroll pages
        emitStatus(testEnv.testId, 'preloading', 'Pre-loading and scrolling pages to ensure full content is captured...');
        logMessage(testEnv.testId, `Pre-loading ${routesToTest.length} pages...`);
        
        let preloadedCount = 0;
        for (const route of routesToTest) {
            const fullProdUrl = prodUrl + route;
            const fullStagingUrl = stagingUrl + route;
            
            // Pre-load production URL
            const prodResult = await loadAndScrollPage({ url: fullProdUrl });
            if (prodResult.success) {
                logMessage(testEnv.testId, `✓ Pre-loaded production: ${fullProdUrl}`);
            } else {
                logMessage(testEnv.testId, `⚠ Failed to pre-load production: ${fullProdUrl}`, 'warning');
            }
            
            // Pre-load staging URL
            const stagingResult = await loadAndScrollPage({ url: fullStagingUrl });
            if (stagingResult.success) {
                logMessage(testEnv.testId, `✓ Pre-loaded staging: ${fullStagingUrl}`);
            } else {
                logMessage(testEnv.testId, `⚠ Failed to pre-load staging: ${fullStagingUrl}`, 'warning');
            }
            
            preloadedCount++;
            emitStepProgress(testEnv.testId, 'preloading', preloadedCount, routesToTest.length, `Pre-loaded ${preloadedCount}/${routesToTest.length} pages`);
        }
        
        emitStatus(testEnv.testId, 'preloading-complete', `Pre-loading completed for ${routesToTest.length} routes`);
        logMessage(testEnv.testId, `Pre-loading completed for ${routesToTest.length} routes`);
        
        // Step 4: Generate config
        emitStatus(testEnv.testId, 'generating-config', `Generating test configuration for ${routesToTest.length} routes...`);
        logMessage(testEnv.testId, `Testing ${routesToTest.length} routes`);
        
        const config = generateBackstopConfig(prodUrl, stagingUrl, routesToTest, testEnv);
        const configPath = path.join(testEnv.backstopDataDir, 'backstop.config.js');
        fs.writeFileSync(configPath, `module.exports = ${JSON.stringify(config, null, 2)};`);
        
        emitStatus(testEnv.testId, 'config-ready', 'Test configuration generated successfully');
        
        // Step 5: Run BackstopJS reference
        emitStatus(testEnv.testId, 'creating-reference', 'Creating reference images from staging environment...');
        logMessage(testEnv.testId, 'Creating reference images...');
        
        runBackstopCommand('reference', configPath, testEnv.testId, (code, output, error) => {
            if (code === 0) {
                emitStatus(testEnv.testId, 'reference-complete', 'Reference images created successfully');
                logMessage(testEnv.testId, 'Reference images created successfully');
                
                // Step 6: Run BackstopJS test
                emitStatus(testEnv.testId, 'running-test', 'Starting visual comparison with production environment...');
                logMessage(testEnv.testId, 'Starting comparison...');
                
                runBackstopCommand('test', configPath, testEnv.testId, (testCode, testOutput, testError) => {
                    testEnv.isRunning = false;
                    
                    if (testCode === 0) {
                        emitStatus(testEnv.testId, 'completed', 'Test completed successfully - no visual differences found!');
                        logMessage(testEnv.testId, 'Test completed - no differences found');
                    } else if (testCode === 1) {
                        emitStatus(testEnv.testId, 'completed-with-differences', 'Test completed - visual differences detected');
                        logMessage(testEnv.testId, 'Test completed - differences found');
                    } else {
                        emitStatus(testEnv.testId, 'error', `Test failed with exit code: ${testCode}`);
                        logMessage(testEnv.testId, `Test completed with exit code: ${testCode}`);
                    }
                    
                    // Final completion with report URL
                    emitComplete(testEnv.testId, `/backstop_data/${testEnv.testId}/html_report/index.html`);
                });
                
            } else {
                testEnv.isRunning = false;
                emitStatus(testEnv.testId, 'error', `Failed to create reference images. Exit code: ${code}`);
                logMessage(testEnv.testId, `Failed to create reference images. Exit code: ${code}`, 'error');
                emitError(testEnv.testId, `Failed to create reference images`);
            }
        });

        res.json({ 
            message: 'Test process started - check WebSocket for real-time updates',
            testId: testEnv.testId
        });
        
    } catch (error) {
        testEnv.isRunning = false;
        emitStatus(testEnv.testId, 'error', `Test process failed: ${error.message}`);
        logMessage(testEnv.testId, `Test process failed: ${error.message}`, 'error');
        emitError(testEnv.testId, error.message);
        res.status(500).json({ error: error.message });
    }
});

// Upload Excel file
app.post('/api/upload-excel', (req, res) => {
    const testEnv = createTestEnvironment();
    const upload = multer({ dest: testEnv.uploadsDir });
    
    upload.single('file')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: 'File upload failed' });
        }
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        testEnv.lastUploadedExcel = req.file.path;
        logMessage(testEnv.testId, 'Excel file uploaded successfully');
        
        res.json({ 
            message: 'Excel file uploaded successfully',
            testId: testEnv.testId
        });
    });
});


// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        activeEnvironments: activeTestEnvironments.size,
        connectedClients: wsClients.size,
        timestamp: new Date().toISOString()
    });
});
app.post('/api/test-excel', async (req, res) => {
    const testEnvironments = Array.from(activeTestEnvironments.values());
    const testEnv = testEnvironments[testEnvironments.length - 1];
    
    if (!testEnv || !testEnv.lastUploadedExcel) {
        return res.status(400).json({ error: 'No Excel file uploaded' });
    }
    
    if (testEnv.isRunning) {
        return res.status(429).json({ error: 'A test is already running' });
    }
    testEnv.isRunning = true;
    
    try {
        emitStatus(testEnv.testId, 'started', 'Excel test started - parsing file...');
        
        // Parse Excel file
        emitStatus(testEnv.testId, 'processing', 'Parsing Excel file...');
        const workbook = XLSX.readFile(testEnv.lastUploadedExcel);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        
        emitStatus(testEnv.testId, 'processing', 'Extracting URLs from Excel file...');
        const urls = data.flat().filter(cell => typeof cell === 'string' && cell.startsWith('http'));
        
        if (urls.length === 0) {
            testEnv.isRunning = false;
            emitError(testEnv.testId, 'No URLs found in Excel file');
            return res.status(400).json({ error: 'No URLs found in Excel file' });
        }
        
        emitStatus(testEnv.testId, 'processing', `Found ${urls.length} URLs - preparing test environment...`);
        logMessage(testEnv.testId, `Processing ${urls.length} URLs from Excel file`);
        
        // Clear existing data
        clearBackstopData(testEnv);
        
        // Generate scenarios for BackstopJS
        emitStatus(testEnv.testId, 'generating-config', 'Generating test configuration...');
        const scenarios = urls.map((url, i) => ({
            label: `URL_${i+1}`,
            url,
            referenceUrl: url,
            selectors: ["document"],
            misMatchThreshold: 0.1,
            requireSameDimensions: true,
            waitForSelector: 'body',
            delay: 3000,
            postInteractionWait: 1000
        }));
        
        const config = {
            id: `excel_test_${testEnv.testId}`,
            viewports: [
                { label: "phone", width: 375, height: 667 },
                { label: "tablet", width: 1024, height: 768 },
                { label: "desktop", width: 1920, height: 1080 }
            ],
            scenarios,
            paths: {
                bitmaps_reference: path.resolve(testEnv.backstopDataDir, 'bitmaps_reference'),
                bitmaps_test: path.resolve(testEnv.backstopDataDir, 'bitmaps_test'),
                engine_scripts: path.resolve(testEnv.backstopDataDir, 'engine_scripts'),
                html_report: path.resolve(testEnv.backstopDataDir, 'html_report'),
                ci_report: path.resolve(testEnv.backstopDataDir, 'ci_report')
            },
            report: ["browser", "CI"],
            engine: "puppeteer",
            engineOptions: { 
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu"
                ]
            },
            asyncCaptureLimit: 5,
            asyncCompareLimit: 50,
            debug: false,
            openReport: false
        };
        
        const configPath = path.join(testEnv.backstopDataDir, 'backstop.config.js');
        fs.writeFileSync(configPath, `module.exports = ${JSON.stringify(config, null, 2)};`);
        
        // Step 1: Run BackstopJS reference
        emitStatus(testEnv.testId, 'creating-reference', 'Creating reference screenshots from Excel URLs...');
        logMessage(testEnv.testId, 'Creating reference screenshots...');
        
        runBackstopCommand('reference', configPath, testEnv.testId, (code, output, error) => {
            if (code === 0) {
                emitStatus(testEnv.testId, 'reference-complete', 'Reference screenshots created successfully');
                logMessage(testEnv.testId, 'Reference screenshots created successfully');
                
                // Step 2: Run BackstopJS test to generate HTML report
                emitStatus(testEnv.testId, 'running-test', 'Generating HTML report...');
                logMessage(testEnv.testId, 'Generating BackstopJS HTML report...');
                
                runBackstopCommand('test', configPath, testEnv.testId, (testCode, testOutput, testError) => {
                testEnv.isRunning = false;
                    
                    // For Excel tests, we expect exit code 0 (no differences) since we're comparing URLs against themselves
                if (testCode === 0) {
                        emitStatus(testEnv.testId, 'completed', 'Excel test completed successfully - HTML report generated');
                        logMessage(testEnv.testId, 'HTML report generated successfully');
                } else if (testCode === 1) {
                        // Exit code 1 means differences found, but that's expected for some cases
                        emitStatus(testEnv.testId, 'completed', 'Excel test completed - HTML report generated');
                        logMessage(testEnv.testId, 'HTML report generated successfully');
                } else {
                        emitStatus(testEnv.testId, 'error', `Failed to generate HTML report. Exit code: ${testCode}`);
                        logMessage(testEnv.testId, `Failed to generate HTML report. Exit code: ${testCode}`, 'error');
                        emitError(testEnv.testId, 'Failed to generate HTML report');
                        return;
                    }
                    
                    // Send completion with BackstopJS HTML report URL
                    emitComplete(testEnv.testId, `/backstop_data/${testEnv.testId}/html_report/index.html`);
                });
                
        } else {
                testEnv.isRunning = false;
                emitStatus(testEnv.testId, 'error', `Failed to create reference screenshots. Exit code: ${code}`);
                logMessage(testEnv.testId, `Failed to create reference screenshots. Exit code: ${code}`, 'error');
                emitError(testEnv.testId, 'Failed to create reference screenshots');
            }
        });
        
    res.json({ 
            message: 'Excel test process started - BackstopJS HTML report will be generated',
        testId: testEnv.testId
        });
        
    } catch (error) {
        testEnv.isRunning = false;
        emitStatus(testEnv.testId, 'error', `Excel test failed: ${error.message}`);
        logMessage(testEnv.testId, `Excel test failed: ${error.message}`, 'error');
        emitError(testEnv.testId, error.message);
        res.status(500).json({ error: error.message });
    }
});

// WebSocket handling
wss.on('connection', (ws) => {
    const socketId = crypto.randomBytes(8).toString('hex');
    console.log(`WebSocket client connected: ${socketId}`);
    
    // Initialize with empty subscriptions instead of 'all' by default
    wsClients.set(socketId, { 
        ws, 
        subscriptions: [], // Start with no subscriptions
        lastPing: Date.now() 
    });
    
    ws.on('message', (message) => {
        try {
            const parsedMessage = JSON.parse(message.toString());
            const { type, data } = parsedMessage;
            
            switch (type) {
                case 'subscribe':
                    handleSubscribe(socketId, data);
                    break;
                case 'unsubscribe':
                    handleUnsubscribe(socketId, data);
                    break;
                case 'ping':
                    handlePing(socketId);
                    break;
                case 'get-logs':
                    handleGetLogs(socketId, data);
                    break;
            }
        } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`WebSocket client disconnected: ${socketId}`);
        wsClients.delete(socketId);
    });
    
    ws.on('error', (error) => {
        console.error(`WebSocket error for client ${socketId}:`, error);
        wsClients.delete(socketId);
    });
    
    // Send connection acknowledgment
            ws.send(JSON.stringify({
        type: 'connected',
                data: { 
            message: 'WebSocket connected successfully - subscribe to specific testId or "all" to receive logs',
            socketId,
            subscriptions: [],
            timestamp: new Date().toISOString()
                }
            }));
});

function handleSubscribe(socketId, data) {
        const clientInfo = wsClients.get(socketId);
    if (!clientInfo) return;
    
    const { testId } = data;
    
    // Clear all previous subscriptions and set only the new one
    // Do not allow "all" subscriptions to prevent cross-contamination
    if (testId && testId !== "all") {
        clientInfo.subscriptions = [testId];
        console.log(`Client ${socketId} subscribed ONLY to: ${testId}`);
        
        clientInfo.ws.send(JSON.stringify({
            type: "subscribed",
                data: { 
                testId,
                subscriptions: clientInfo.subscriptions,
                message: `Subscribed exclusively to test ${testId}`,
                timestamp: new Date().toISOString()
                }
            }));
        } else {
        // Clear all subscriptions if trying to subscribe to "all" or invalid testId
        clientInfo.subscriptions = [];
        console.log(`Client ${socketId} cleared all subscriptions (requested: ${testId})`);
        
        clientInfo.ws.send(JSON.stringify({
            type: "subscribed",
            data: {
                testId: null,
                subscriptions: [],
                message: "No active subscriptions - start a test to receive updates",
                timestamp: new Date().toISOString()
            }
        }));
    }
}

function handleUnsubscribe(socketId, data) {
    const clientInfo = wsClients.get(socketId);
    if (!clientInfo) return;
    
    const { testId } = data;
    
    if (testId) {
        clientInfo.subscriptions = clientInfo.subscriptions.filter(sub => sub !== testId);
    }
    
    clientInfo.ws.send(JSON.stringify({
        type: 'unsubscribed',
        data: {
            testId,
            subscriptions: clientInfo.subscriptions,
            message: testId ? `Unsubscribed from test ${testId}` : 'Subscription updated',
            timestamp: new Date().toISOString()
        }
    }));
}

function handleGetLogs(socketId, data) {
    const clientInfo = wsClients.get(socketId);
    if (!clientInfo) return;
    
    // Send recent logs (you could implement log storage here)
    clientInfo.ws.send(JSON.stringify({
        type: 'logs-history',
        data: {
            message: 'Log history not implemented - you will receive real-time logs based on your subscriptions',
            timestamp: new Date().toISOString()
        }
    }));
}

function handlePing(socketId) {
    const clientInfo = wsClients.get(socketId);
    if (clientInfo) {
        clientInfo.lastPing = Date.now();
        clientInfo.ws.send(JSON.stringify({
            type: 'pong',
            data: { timestamp: new Date().toISOString() }
        }));
    }
}

// Cleanup dead WebSocket connections
setInterval(() => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    
    wsClients.forEach((clientInfo, socketId) => {
        if (clientInfo.lastPing < fiveMinutesAgo || clientInfo.ws.readyState !== WebSocket.OPEN) {
            console.log(`Cleaning up dead WebSocket connection: ${socketId}`);
            wsClients.delete(socketId);
        }
    });
}, 60000); // Check every minute

const PORT = process.env.PORT || 3000;

// Error handlers
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Broadcast critical error to all clients (server-level message)
    broadcastToAllClients({
        type: 'server-error',
        data: {
            error: 'Server encountered a critical error',
            timestamp: new Date().toISOString()
        }
    });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    
    // Close browser first
    if (globalBrowser) {
        try {
            await globalBrowser.close();
            console.log('Browser closed successfully');
        } catch (error) {
            console.error('Error closing browser:', error);
        }
    }
    
    // Notify all clients about shutdown (server-level message)
    broadcastToAllClients({
        type: 'server-shutdown',
        data: {
            message: 'Server is shutting down',
            timestamp: new Date().toISOString()
        }
    });
    
    // Close all WebSocket connections
    wsClients.forEach((clientInfo) => {
        if (clientInfo.ws.readyState === WebSocket.OPEN) {
            clientInfo.ws.close();
        }
    });
    
    http.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully');
    
    // Close browser first
    if (globalBrowser) {
        try {
            await globalBrowser.close();
            console.log('Browser closed successfully');
        } catch (error) {
            console.error('Error closing browser:', error);
        }
    }
    
    broadcastToAllClients({
        type: 'server-shutdown',
        data: {
            message: 'Server is shutting down',
            timestamp: new Date().toISOString()
        }
    });
    
    wsClients.forEach((clientInfo) => {
        if (clientInfo.ws.readyState === WebSocket.OPEN) {
            clientInfo.ws.close();
        }
    });
    
    http.close(() => process.exit(0));
});

// app.get('/api/test/:testId/status', (req, res) => {
//     const testId = req.params.testId;
//     const testEnv = activeTestEnvironments.get(testId);
    
//     if (!testEnv) {
//         return res.status(404).json({ error: 'Test environment not found' });
//     }
    
//     res.json({
//         testId,
//         isRunning: testEnv.isRunning,
//         createdAt: testEnv.createdAt,
//         lastActivity: testEnv.lastActivity,
//         hasExcelFile: !!testEnv.lastUploadedExcel
//     });
// });

http.listen(PORT, async () => {
    console.log(`🚀 Visual Regression Server running on port ${PORT}`);
    console.log(`📊 Open http://localhost:${PORT} to start testing`);
    console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}/ws`);
    
    // Test Puppeteer availability
    const puppeteerWorking = await testPuppeteer();
    
    // Check BackstopJS availability
    const { exec } = require('child_process');
    exec('npx backstop --version', (error, stdout, stderr) => {
        if (error) {
            console.log('⚠️  BackstopJS not found. Please run: npm install');
            console.error('BackstopJS error:', error.message);
        } else {
            console.log('✅ BackstopJS ready:', stdout.trim());
        }
        
        if (puppeteerWorking) {
            console.log('🎯 System ready for visual regression testing!');
        } else {
            console.log('⚠️  Chrome/Puppeteer issues detected - visual tests may fail');
        }
    });
});

// Test Chrome/Puppeteer availability on startup
async function testPuppeteer() {
    let browser = null;
    let page = null;
    
    try {
        console.log('🔍 Testing Puppeteer/Chrome availability...');
        browser = await getBrowserInstance();
        page = await browser.newPage();
        await page.goto('https://example.com', { timeout: 30000 });
        console.log('✅ Puppeteer/Chrome is working correctly');
        return true;
    } catch (error) {
        console.error('❌ Puppeteer/Chrome test failed:', error.message);
        console.error('Chrome executable path:', process.env.PUPPETEER_EXECUTABLE_PATH);
        return false;
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (error) {
                console.error('Error closing page:', error);
            }
        }
        releaseBrowserSession();
    }
}

// Get or create shared browser instance
async function getBrowserInstance() {
    if (activeBrowserSessions >= MAX_CONCURRENT_SESSIONS) {
        throw new Error('Maximum concurrent browser sessions reached. Please wait and try again.');
    }

    if (globalBrowser && globalBrowser.isConnected()) {
        activeBrowserSessions++;
        return globalBrowser;
    }

    if (browserLaunchPromise) {
        globalBrowser = await browserLaunchPromise;
        activeBrowserSessions++;
        return globalBrowser;
    }

    browserLaunchPromise = puppeteer.launch(PUPPETEER_CONFIG);
    globalBrowser = await browserLaunchPromise;
    activeBrowserSessions++;
    browserLaunchPromise = null;
    
    return globalBrowser;
}

// Release browser session
function releaseBrowserSession() {
    activeBrowserSessions = Math.max(0, activeBrowserSessions - 1);
    
    // Close browser if no active sessions
    if (activeBrowserSessions === 0 && globalBrowser) {
        setTimeout(async () => {
            if (activeBrowserSessions === 0 && globalBrowser) {
                try {
                    await globalBrowser.close();
                    globalBrowser = null;
                } catch (error) {
                    console.error('Error closing browser:', error);
                }
            }
        }, 30000); // Close after 30 seconds of inactivity
    }
}