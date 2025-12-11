const { Actor } = require('apify');
const { PlaywrightCrawler, createPlaywrightRouter, log } = require('crawlee');

// Production-ready LinkedIn scraper with anti-detection measures
Actor.main(async () => {
    // Initialize Apify SDK by getting input first
    const input = await Actor.getInput();

    // Configuration with defaults
    const {
        searchQueries = ['Software Engineer'],
        location = 'United States',
        maxResults = 100,
        maxConcurrency = 2, // LinkedIn requires low concurrency
        proxyConfiguration = { useApifyProxy: true },
        extendOutputFunction = null,
        customData = {},
        linkedinCookies = null, // Optional: LinkedIn session cookies
        minDelayBetweenRequests = 2000, // Milliseconds
        maxDelayBetweenRequests = 5000,
        debugMode = false,
    } = input || {};

    // Input validation
    if (!searchQueries || searchQueries.length === 0) {
        throw new Error('searchQueries parameter must be provided and non-empty');
    }

    if (!location || location.trim().length === 0) {
        throw new Error('location parameter must be provided and non-empty');
    }

    // Request queue and dataset
    const requestQueue = await Actor.openRequestQueue();
    const dataset = await Actor.openDataset();
    const kvStore = await Actor.openKeyValueStore();

    // Track statistics
    const stats = {
        startTime: new Date(),
        jobsFound: 0,
        jobsScraped: 0,
        errors: 0,
        ipBlocked: false,
    };

    // Random delay function for human-like behavior
    const randomDelay = async () => {
        const delay = Math.random() * (maxDelayBetweenRequests - minDelayBetweenRequests) + minDelayBetweenRequests;
        await new Promise(resolve => setTimeout(resolve, delay));
    };

    // Generate realistic user agents
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    ];

    const getRandomUserAgent = () => userAgents[Math.floor(Math.random() * userAgents.length)];

    // Prepare search URLs
    const searchUrls = searchQueries.map(query => {
        const encodedQuery = encodeURIComponent(query);
        const encodedLocation = encodeURIComponent(location);
        return `https://www.linkedin.com/jobs/search/?keywords=${encodedQuery}&location=${encodedLocation}&start=0`;
    });

    // Add initial search URLs to queue
    for (const url of searchUrls) {
        await requestQueue.addRequest({
            url,
            userData: {
                label: 'SEARCH',
                query: searchQueries[searchUrls.indexOf(url)],
                location,
                retryCount: 0,
            },
            retryCount: 0,
        });
    }

    // Create Playwright router with anti-detection
    const router = createPlaywrightRouter();

    // Search results handler
    router.addHandler('SEARCH', async ({ page, request, enqueueLinks }) => {
        log.info(`[SEARCH] Processing: ${request.url}`);

        try {
            // Wait for search results to load
            await page.waitForSelector('.base-card', { timeout: 15000 }).catch(() => {
                log.warning('Search results container not found, page may be blocked');
            });

            // Get job listing count
            const jobCount = await page.$$eval('.base-card', cards => cards.length);
            stats.jobsFound += jobCount;
            log.info(`[SEARCH] Found ${jobCount} job listings on this page`);

            // Debug: If no jobs found, capture page info
            if (jobCount === 0) {
                const pageInfo = await page.evaluate(() => {
                    return {
                        title: document.title,
                        url: window.location.href,
                        bodyText: document.body.innerText.substring(0, 500),
                        hasLoginForm: !!document.querySelector('form[data-id="sign-in-form"]'),
                        hasChallengeForm: !!document.querySelector('[data-test-id="challenge"]'),
                        hasJobsContainer: !!document.querySelector('.jobs-search__results-list'),
                    };
                });
                log.warning(`[DEBUG] Page Info: ${JSON.stringify(pageInfo, null, 2)}`);

                // Take screenshot for debugging
                if (debugMode) {
                    const screenshot = await page.screenshot({ fullPage: false });
                    await Actor.setValue('blocked-page-screenshot', screenshot, { contentType: 'image/png' });
                }
            }

            // Extract and enqueue job detail URLs
            await enqueueLinks({
                selector: 'a.base-card__full-link',
                userData: {
                    label: 'JOB_DETAIL',
                    searchQuery: request.userData.query,
                    location: request.userData.location,
                },
                requestQueue,
            });

            // Handle pagination
            const hasNextPage = await page.$('a[aria-label="View next page"]') !== null;
            if (hasNextPage && stats.jobsScraped < maxResults) {
                const nextPageUrl = await page.evaluate(() => {
                    const nextBtn = document.querySelector('a[aria-label="View next page"]');
                    return nextBtn ? nextBtn.href : null;
                });

                if (nextPageUrl) {
                    await requestQueue.addRequest({
                        url: nextPageUrl,
                        userData: {
                            label: 'SEARCH',
                            query: request.userData.query,
                            location: request.userData.location,
                            retryCount: 0,
                        },
                    });
                    log.info('[SEARCH] Next page queued');
                }
            }
        } catch (error) {
            log.error(`[SEARCH] Error processing search page: ${error.message}`);
            stats.errors++;
            throw error;
        }
    });

    // Job detail handler
    router.addHandler('JOB_DETAIL', async ({ page, request }) => {
        log.info(`[JOB_DETAIL] Processing: ${request.url}`);

        try {
            // Wait for job details to load
            await page.waitForSelector('[data-test="top-card-title"]', { timeout: 12000 }).catch(() => {
                log.warning('Job title element not found');
            });

            // Scroll to load all content
            await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight);
            });
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Extract basic job information
            const jobData = await page.evaluate(() => {
                const getText = (selector) => {
                    const element = document.querySelector(selector);
                    return element ? element.textContent.trim() : '';
                };

                const getAllText = (selector) => {
                    const elements = document.querySelectorAll(selector);
                    return Array.from(elements).map(el => el.textContent.trim()).filter(text => text.length > 0);
                };

                return {
                    title: getText('[data-test="top-card-title"]'),
                    company: getText('a[data-test="top-card-org-name-link"]'),
                    location: getText('[data-test="top-card-location"]'),
                    locationType: getText('[data-test="job-details-location-type-label"]'),
                    seniority: getText('[data-test="job-criteria-seniority-level-skill-label"]'),
                    employmentType: getText('[data-test="job-details-employment-type-label"]'),
                    description: getText('[data-test="job-details-jobs-details__main-content"]'),
                    salary: getText('[data-test="job-details-compensation-label"]'),
                    criteria: getAllText('[data-test="job-details-job-criteria-item-subtitle"]'),
                    postedDate: getText('span[aria-label*="ago"]'),
                };
            });

            // Extract hiring team information
            const hiringTeam = await page.evaluate(() => {
                const team = [];

                // Primary method: Get from recruiter profile cards
                const recruiterCards = document.querySelectorAll('[data-section-id="hiring_team"] [data-entity-index]');
                recruiterCards.forEach(card => {
                    const nameElement = card.querySelector('[data-test*="entity-profile-title"]');
                    const titleElement = card.querySelector('[data-test*="entity-profile-subtitle"]');
                    const linkElement = card.querySelector('a[data-test*="profile-link"]');

                    team.push({
                        name: nameElement ? nameElement.textContent.trim() : 'Unknown',
                        title: titleElement ? titleElement.textContent.trim() : 'Unknown',
                        profileUrl: linkElement ? linkElement.href : '',
                    });
                });

                // Fallback: Try alternative selectors
                if (team.length === 0) {
                    const alternateCards = document.querySelectorAll('[data-section-id="hiring_team"] li');
                    alternateCards.forEach(card => {
                        const link = card.querySelector('a');
                        if (link) {
                            team.push({
                                name: link.textContent.trim(),
                                profileUrl: link.href,
                                title: 'Recruiter',
                            });
                        }
                    });
                }

                return team;
            });

            // Compile complete job record
            const job = {
                url: request.url,
                title: jobData.title || 'Not specified',
                company: jobData.company || 'Not specified',
                location: jobData.location || 'Not specified',
                locationType: jobData.locationType || 'Not specified',
                seniority: jobData.seniority || 'Not specified',
                employmentType: jobData.employmentType || 'Not specified',
                description: jobData.description || 'Not specified',
                salary: jobData.salary || 'Not specified',
                jobCriteria: jobData.criteria,
                postedDate: jobData.postedDate || 'Not specified',
                hiringTeam: hiringTeam,
                searchQuery: request.userData.searchQuery,
                location_filter: request.userData.location,
                scrapedAt: new Date().toISOString(),
                customData: customData,
            };

            // Apply custom extension function if provided
            if (extendOutputFunction) {
                try {
                    const extensionFunc = new Function('job', 'page', 'request', `return (${extendOutputFunction})(job, page, request)`);
                    const extendedJob = await extensionFunc(job, page, request);
                    await dataset.pushData(extendedJob || job);
                } catch (error) {
                    log.error(`Error in extendOutputFunction: ${error.message}`);
                    await dataset.pushData(job);
                }
            } else {
                await dataset.pushData(job);
            }

            stats.jobsScraped++;
            log.info(`[JOB_DETAIL] ✓ Scraped: ${job.title} at ${job.company}`);

        } catch (error) {
            log.error(`[JOB_DETAIL] Error scraping job details: ${error.message}`);
            stats.errors++;
            throw error;
        }
    });

    // Configure Playwright crawler with anti-detection
    const crawler = new PlaywrightCrawler({
        requestQueue,
        maxConcurrency: Math.min(maxConcurrency, 2), // Strict low concurrency for LinkedIn
        maxRequestRetries: 5,
        requestHandlerTimeoutSecs: 90,
        navigationTimeoutSecs: 60,

        // Proxy configuration - use residential proxies for production
        proxyConfiguration: await Actor.createProxyConfiguration(proxyConfiguration),

        // Launch context with anti-detection measures
        launchContext: {
            useChrome: false,
            launchOptions: {
                headless: true,
                // Disable headless mode signature
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-web-resources',
                    '--disable-client-side-phishing-detection',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                ],
            },
        },

        // Pre-navigation hooks for headers and delays
        preNavigationHooks: [
            async (context) => {
                // Random delay to simulate human behavior
                await randomDelay();

                const page = context.page;

                // Add headers
                await page.setExtraHTTPHeaders({
                    'User-Agent': getRandomUserAgent(),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Cache-Control': 'max-age=0',
                });

                // Inject stealth scripts
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', {
                        get: () => false,
                    });
                    Object.defineProperty(navigator, 'platform', {
                        get: () => 'Linux x86_64',
                    });
                });

                // Add optional cookies if provided (e.g., LinkedIn session)
                if (linkedinCookies) {
                    try {
                        let cookies;

                        // Handle both string and object inputs
                        if (typeof linkedinCookies === 'string') {
                            cookies = JSON.parse(linkedinCookies);
                        } else {
                            cookies = linkedinCookies;
                        }

                        // Validate cookies format
                        if (!Array.isArray(cookies)) {
                            throw new Error('Cookies must be an array');
                        }

                        // Normalize cookies to Playwright format
                        const normalizedCookies = cookies.map(cookie => {
                            // Convert sameSite values
                            let sameSite = 'Lax'; // Default
                            if (cookie.sameSite === 'no_restriction') {
                                sameSite = 'None';
                            } else if (cookie.sameSite === 'lax' || cookie.sameSite === 'Lax') {
                                sameSite = 'Lax';
                            } else if (cookie.sameSite === 'strict' || cookie.sameSite === 'Strict') {
                                sameSite = 'Strict';
                            } else if (cookie.sameSite === 'None') {
                                sameSite = 'None';
                            }

                            const normalized = {
                                name: cookie.name,
                                value: cookie.value,
                                domain: cookie.domain,
                                path: cookie.path || '/',
                                httpOnly: cookie.httpOnly || false,
                                secure: cookie.secure !== undefined ? cookie.secure : true,
                                sameSite: sameSite,
                            };

                            // Convert expirationDate to expires (Unix timestamp)
                            if (cookie.expirationDate) {
                                normalized.expires = Math.floor(cookie.expirationDate);
                            } else if (cookie.expires) {
                                normalized.expires = cookie.expires;
                            }

                            return normalized;
                        });

                        await page.context().addCookies(normalizedCookies);
                        log.info(`LinkedIn session cookies loaded successfully (${normalizedCookies.length} cookies)`);
                    } catch (error) {
                        log.warning(`Failed to parse LinkedIn cookies: ${error.message}`);
                        if (debugMode) {
                            log.warning(`Cookie input type: ${typeof linkedinCookies}`);
                            log.warning(`Cookie input value: ${JSON.stringify(linkedinCookies).substring(0, 200)}...`);
                        }
                    }
                }
            }
        ],

        // Post-navigation hooks for additional checks
        postNavigationHooks: [
            async (context) => {
                const page = context.page;

                // Check for LinkedIn sign-in page (blocked)
                const isSignInPage = await page.url().includes('/login');
                if (isSignInPage) {
                    log.error('❌ IP BLOCKED: LinkedIn sign-in page detected');
                    stats.ipBlocked = true;
                    throw new Error('LinkedIn IP blocked - redirected to login');
                }

                // Check for error page
                const errorText = await page.evaluate(() => document.body.textContent);
                if (errorText.includes('something went wrong') || errorText.includes('temporarily unavailable')) {
                    log.error('⚠️ LinkedIn error page detected');
                    throw new Error('LinkedIn error page');
                }
            }
        ],

        // Error handling
        failedRequestHandler: async ({ request, error }) => {
            log.error(`❌ Request failed: ${request.url}`);
            log.error(`   Error: ${error.message}`);
            stats.errors++;

            // Check if IP is blocked
            if (error.message.includes('sign-in') || error.message.includes('blocked')) {
                stats.ipBlocked = true;
            }

            // Save failed URL for review
            await kvStore.setValue(
                `failed-url-${Date.now()}`,
                { url: request.url, error: error.message, label: request.userData.label }
            );
        },

        // Request handler with router
        requestHandler: router,
    });

    try {
        log.info('🚀 Starting LinkedIn Jobs Scraper (Production Mode)');
        log.info(`   Queries: ${searchQueries.join(', ')}`);
        log.info(`   Location: ${location}`);
        log.info(`   Concurrency: ${Math.min(maxConcurrency, 2)}`);

        await crawler.run();

        // Save statistics
        stats.endTime = new Date();
        stats.duration = stats.endTime - stats.startTime;

        log.info(`
╔════════════════════════════════════════╗
║         SCRAPING COMPLETED            ║
╠════════════════════════════════════════╣
║ Jobs Found:        ${String(stats.jobsFound).padEnd(21)} ║
║ Jobs Scraped:      ${String(stats.jobsScraped).padEnd(21)} ║
║ Errors:            ${String(stats.errors).padEnd(21)} ║
║ IP Blocked:        ${String(stats.ipBlocked ? 'YES' : 'NO').padEnd(21)} ║
║ Duration:          ${String(Math.round(stats.duration / 1000) + 's').padEnd(21)} ║
╚════════════════════════════════════════╝
        `);

        await kvStore.setValue('final-stats', stats);

    } catch (error) {
        log.error(`Fatal error: ${error.message}`);
        stats.error = error.message;
        await kvStore.setValue('fatal-error', stats);
        throw error;
    }
});