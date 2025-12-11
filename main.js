const { Actor } = require('apify');
const { PlaywrightCrawler, createPlaywrightRouter, log } = require('crawlee');

// Production-ready LinkedIn scraper with anti-detection measures
Actor.main(async () => {
    // Initialize Apify SDK by getting input first
    const input = await Actor.getInput();

    // Configuration with defaults
    const {
        searchUrl = [],
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
    if (!searchUrl || searchUrl.length === 0) {
        throw new Error('searchUrl parameter must be provided and non-empty. Please provide LinkedIn job search URLs.');
    }

    // Validate URLs
    for (const url of searchUrl) {
        if (!url.includes('linkedin.com/jobs')) {
            throw new Error(`Invalid URL: ${url}. Must be a LinkedIn jobs search URL.`);
        }
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

    // Add initial search URLs to queue
    for (const url of searchUrl) {
        await requestQueue.addRequest({
            url,
            userData: {
                label: 'SEARCH',
                searchUrl: url,
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

            // Extract job detail URLs with multiple fallback selectors
            const jobLinks = await page.evaluate(() => {
                const links = [];

                // Try multiple selectors for job links
                const selectors = [
                    'a.base-card__full-link',
                    '.job-card-container__link',
                    '.jobs-search-results__list-item a[href*="/jobs/view/"]',
                    'a[data-tracking-control-name="public_jobs_jserp-result_search-card"]',
                    '.base-search-card__title',
                    'a.base-card__link',
                ];

                for (const selector of selectors) {
                    const elements = document.querySelectorAll(selector);
                    if (elements.length > 0) {
                        elements.forEach(el => {
                            const href = el.href || el.getAttribute('href');
                            if (href && href.includes('/jobs/view/')) {
                                links.push(href);
                            }
                        });
                        if (links.length > 0) {
                            break; // Found links with this selector, stop trying others
                        }
                    }
                }

                return [...new Set(links)]; // Remove duplicates
            });

            log.info(`[SEARCH] Extracted ${jobLinks.length} job URLs`);
            if (jobLinks.length > 0) {
                log.info(`[SEARCH] Sample URLs: ${jobLinks.slice(0, 3).join(', ')}`);
            }

            // Enqueue job detail URLs
            for (const url of jobLinks) {
                await requestQueue.addRequest({
                    url,
                    userData: {
                        label: 'JOB_DETAIL',
                        searchUrl: request.userData.searchUrl,
                    },
                });
            }

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
                            searchUrl: request.userData.searchUrl,
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
                const getText = (selectors) => {
                    // Accept array of selectors and try each one
                    const selectorArray = Array.isArray(selectors) ? selectors : [selectors];
                    for (const selector of selectorArray) {
                        const element = document.querySelector(selector);
                        if (element && element.textContent.trim()) {
                            return element.textContent.trim();
                        }
                    }
                    return '';
                };

                const getAllText = (selectors) => {
                    const selectorArray = Array.isArray(selectors) ? selectors : [selectors];
                    for (const selector of selectorArray) {
                        const elements = document.querySelectorAll(selector);
                        if (elements.length > 0) {
                            return Array.from(elements).map(el => el.textContent.trim()).filter(text => text.length > 0);
                        }
                    }
                    return [];
                };

                return {
                    title: getText([
                        '[data-test="top-card-title"]',
                        'h1.top-card-layout__title',
                        'h1.t-24',
                        '.job-details-jobs-unified-top-card__job-title h1'
                    ]),
                    company: getText([
                        'a[data-test="top-card-org-name-link"]',
                        '.topcard__org-name-link',
                        '.job-details-jobs-unified-top-card__company-name a',
                        '.topcard__flavor--black-link'
                    ]),
                    location: getText([
                        '[data-test="top-card-location"]',
                        '.topcard__flavor--bullet',
                        '.job-details-jobs-unified-top-card__primary-description-container span'
                    ]),
                    locationType: getText([
                        '[data-test="job-details-location-type-label"]',
                        '.job-details-jobs-unified-top-card__workplace-type'
                    ]),
                    seniority: getText([
                        '[data-test="job-criteria-seniority-level-skill-label"]',
                        '.job-details-jobs-unified-top-card__job-insight span'
                    ]),
                    employmentType: getText([
                        '[data-test="job-details-employment-type-label"]',
                        '.job-details-jobs-unified-top-card__job-insight--highlight'
                    ]),
                    description: getText([
                        '[data-test="job-details-jobs-details__main-content"]',
                        '.jobs-description__content',
                        '.show-more-less-html__markup',
                        '#job-details'
                    ]),
                    salary: getText([
                        '[data-test="job-details-compensation-label"]',
                        '.job-details-jobs-unified-top-card__job-insight--highlight',
                        '.compensation__salary'
                    ]),
                    criteria: getAllText([
                        '[data-test="job-details-job-criteria-item-subtitle"]',
                        '.job-criteria-item__text'
                    ]),
                    postedDate: getText([
                        'span[aria-label*="ago"]',
                        '.jobs-unified-top-card__posted-date',
                        '.topcard__flavor--metadata'
                    ]),
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
                searchUrl: request.userData.searchUrl,
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
        log.info(`   Search URLs: ${searchUrl.length}`);
        searchUrl.forEach((url, index) => {
            log.info(`   [${index + 1}] ${url}`);
        });
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