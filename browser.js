const puppeteer = require("puppeteer-core");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TABLE_NAME = "live_channels";
const REFERER = "https://playsza.st/";

const TARGETS = [
  {
    channelId: "star3in",
    url: "https://playsza.st/uembed.php?id=star3in"
  },
  {
    channelId: "star4b",
    url: "https://playsza.st/uembed.php?id=star4b"
  }
];

// Maximum retries per channel
const MAX_RETRIES = 2;

function cleanUrl(url) {
  if (!url) return null;
  return url
    .replace(/&amp;/gi, "&")
    .replace(/&/g, "&")
    .replace(/\\\//g, "/")
    .trim();
}

function isM3u8(url) {
  return Boolean(url && /\.m3u8(?:[?#]|$)/i.test(url));
}

function extractM3u8FromHtml(html) {
  if (!html) return null;

  const patterns = [
    /https?:\/\/[^"'<>\\\s]+?\.m3u8(?:[?#][^"'<>\\\s]*)?/gi,
    /https?:\\\/\\\/[^"'<>\\\s]+?\.m3u8(?:[?#][^"'<>\\\s]*)?/gi
  ];

  for (const regex of patterns) {
    const matches = html.match(regex) || [];
    for (const match of matches) {
      const url = cleanUrl(match);
      if (isM3u8(url)) return url;
    }
  }

  return null;
}

// Extract from page scripts and iframes
async function extractM3u8FromPage(page) {
  // Method 1: Check page HTML
  const html = await page.content();
  let m3u8 = extractM3u8FromHtml(html);
  if (m3u8) return m3u8;

  // Method 2: Extract from all script tags
  const scriptUrls = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    const urls = [];
    scripts.forEach(script => {
      const content = script.textContent || script.innerHTML;
      const matches = content.match(/https?:\/\/[^"'\s]+?\.m3u8(?:[^"'\s]*)?/gi) || [];
      urls.push(...matches);
    });
    return urls;
  });

  for (const url of scriptUrls) {
    const cleaned = cleanUrl(url);
    if (isM3u8(cleaned)) return cleaned;
  }

  // Method 3: Check iframe sources
  const iframeUrls = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    return iframes.map(iframe => iframe.src).filter(Boolean);
  });

  for (const src of iframeUrls) {
    if (isM3u8(src)) return cleanUrl(src);
  }

  return null;
}

async function updateChannelInSupabase(channelId, streamUrl) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_KEY secret.");
  }

  if (!streamUrl || !isM3u8(streamUrl)) {
    throw new Error("A valid M3U8 URL was not found.");
  }

  const payload = {
    stream_url: streamUrl,
    referer: REFERER,
    created_at: new Date().toISOString()
  };

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };

  const patchUrl =
    `${SUPABASE_URL}/rest/v1/${TABLE_NAME}` +
    `?id=eq.${encodeURIComponent(channelId)}`;

  const patchResponse = await fetch(patchUrl, {
    method: "PATCH",
    headers,
    body: JSON.stringify(payload)
  });

  const patchText = await patchResponse.text();

  if (!patchResponse.ok) {
    throw new Error(
      `Supabase PATCH failed (${patchResponse.status}): ${patchText}`
    );
  }

  let rows = [];
  try {
    rows = patchText ? JSON.parse(patchText) : [];
  } catch {
    throw new Error("Could not parse Supabase PATCH response.");
  }

  if (Array.isArray(rows) && rows.length > 0) {
    console.log(`✅ Supabase row updated: ${channelId}`);
    return;
  }

  // Insert new row
  console.log(`Row ${channelId} not found; attempting insert.`);

  const insertResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/${TABLE_NAME}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: channelId,
        title: channelId,
        name: channelId,
        ...payload,
        category: "Cricket",
        language: "Hindi",
        is_active: true
      })
    }
  );

  const insertText = await insertResponse.text();

  if (!insertResponse.ok) {
    throw new Error(
      `Supabase INSERT failed (${insertResponse.status}): ${insertText}`
    );
  }

  console.log(`✅ Supabase row inserted: ${channelId}`);
}

// Single attempt with one tab
async function processTarget(browser, target) {
  const page = await browser.newPage();

  try {
    // Set viewport and user agent for better compatibility
    await page.setViewport({ width: 1280, height: 720 });

    // Navigate to the page
    console.log(`  → Navigating to page...`);
    await page.goto(target.url, {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // Debug: Print page info
    const title = await page.title();
    const currentUrl = page.url();
    console.log(`  → Page Title: ${title}`);
    console.log(`  → Current URL: ${currentUrl}`);

    // Wait for page to fully render
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Get body text preview
    const bodyPreview = await page.evaluate(() => {
      return document.body?.innerText?.substring(0, 300) || "No body";
    });
    console.log(`  → Body preview: ${bodyPreview.substring(0, 150)}...`);

    // Check if there's a captcha
    const pageCheck = await page.evaluate(() => {
      const bodyText = document.body?.innerText?.toLowerCase() || "";
      const hasCaptcha = bodyText.includes('captcha') ||
             bodyText.includes('verify') ||
             bodyText.includes('cloudflare') ||
             document.querySelector('iframe[src*="captcha"]') !== null ||
             document.querySelector('.g-recaptcha') !== null ||
             document.querySelector('#challenge-form') !== null;

      // Get all iframe sources
      const iframes = Array.from(document.querySelectorAll('iframe')).map(i => i.src);

      // Get all video sources
      const videos = Array.from(document.querySelectorAll('video')).map(v => ({
        src: v.src,
        currentSrc: v.currentSrc
      }));

      // Check for player div
      const playerDivs = document.querySelectorAll('[id*="player"], [class*="player"]');

      return {
        hasCaptcha,
        iframes,
        videos,
        playerCount: playerDivs.length,
        bodyLength: document.body?.innerHTML?.length || 0
      };
    });

    console.log(`  → Captcha detected: ${pageCheck.hasCaptcha}`);
    console.log(`  → Iframes found: ${pageCheck.iframes.length}`);
    if (pageCheck.iframes.length > 0) {
      console.log(`  → Iframe sources: ${JSON.stringify(pageCheck.iframes.slice(0, 3))}`);
    }
    console.log(`  → Videos found: ${pageCheck.videos.length}`);
    console.log(`  → Player divs: ${pageCheck.playerCount}`);
    console.log(`  → HTML size: ${pageCheck.bodyLength} chars`);

    if (pageCheck.hasCaptcha) {
      console.log(`  ⚠️ Captcha/Challenge detected, waiting 15 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 15000));
    }

    // Try to extract M3U8 multiple times
    let m3u8Url = null;

    for (let i = 0; i < 20 && !m3u8Url; i++) {
      m3u8Url = await extractM3u8FromPage(page);

      if (!m3u8Url) {
        if (i % 5 === 0) {
          console.log(`  → Waiting for M3U8... (${i}s)`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!m3u8Url) {
      // Final debug: print full HTML for analysis
      const html = await page.content();
      console.log(`  ❌ No M3U8 found after 20 seconds`);
      console.log(`  → Full HTML (first 1000 chars):`);
      console.log(html.substring(0, 1000));

      throw new Error("No M3U8 URL found");
    }

    console.log(`  ✓ M3U8 found [${target.channelId}]: ${m3u8Url}`);

    // Update Supabase
    await updateChannelInSupabase(target.channelId, m3u8Url);

    return true;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;

  if (!accountId || !token) {
    throw new Error("Missing CF_ACCOUNT_ID or CF_API_TOKEN");
  }

  const endpoint =
    `wss://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/browser-run/devtools/browser?keep_alive=600000`;

  let browser;

  console.log("=== CLOUDFLARE BROWSER STREAM SYNC ===\n");

  try {
    // Connect to Cloudflare Browser
    console.log("Connecting to Cloudflare Browser...");
    browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    console.log("✅ Browser connected\n");

    // Process all targets with retry logic
    for (const target of TARGETS) {
      console.log(`-----------------------------------------`);
      console.log(`Processing: ${target.channelId}`);
      console.log(`URL: ${target.url}`);

      let success = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`[Attempt ${attempt}/${MAX_RETRIES}]`);

        try {
          await processTarget(browser, target);
          console.log(`✅ SUCCESS: ${target.channelId}\n`);
          success = true;
          break;
        } catch (error) {
          console.warn(`[Attempt ${attempt}/${MAX_RETRIES}] Failed: ${error.message}`);

          if (attempt < MAX_RETRIES) {
            console.log(`Retrying in 2 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      if (!success) {
        console.error(`❌ FAILED after ${MAX_RETRIES} attempts: ${target.channelId}\n`);
      }
    }

    console.log("=== ALL TARGETS PROCESSED ===");

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((error) => {
  console.error("Workflow failed:", error.message);
  process.exitCode = 1;
});
