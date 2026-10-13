const puppeteer = require("puppeteer-core");

const BROWSERBASE_API_KEY = "bb_live_5pfZpM9MobOO3FCuksA9a3r8ZDA";
const REFERER = "https://playsza.st/";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TABLE_NAME = "live_channels";

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
    throw new Error(`Supabase PATCH failed (${patchResponse.status}): ${patchText}`);
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
    throw new Error(`Supabase INSERT failed (${insertResponse.status}): ${insertText}`);
  }

  console.log(`✅ Supabase row inserted: ${channelId}`);
}

// Wait for Cloudflare challenge to pass
async function waitForChallenge(page, timeoutMs = 90000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const title = await page.title();
      const bodyText = await page.evaluate(() => {
        return (document.body?.innerText || "").toLowerCase();
      });

      const isChallenge = title.toLowerCase().includes("moment") ||
                          title.toLowerCase().includes("challenge") ||
                          bodyText.includes("checking") ||
                          bodyText.includes("verify") ||
                          bodyText.includes("please wait");

      if (!isChallenge) {
        console.log(`  ✅ Challenge passed (${Math.round((Date.now() - start) / 1000)}s)`);
        return true;
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 10 === 0) {
        console.log(`  ⏳ Waiting for challenge... (${elapsed}s)`);
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return false;
}

// Process a single target
async function processTarget(target) {
  let browser = null;
  let sessionId = null;

  try {
    // Create BrowserBase session via REST API
    console.log(`  → Creating BrowserBase session...`);

    const sessionResponse = await fetch("https://www.browserbase.com/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bb-api-key": BROWSERBASE_API_KEY
      },
      body: JSON.stringify({
        projectId: process.env.BROWSERBASE_PROJECT_ID
      })
    });

    if (!sessionResponse.ok) {
      const errorText = await sessionResponse.text();
      throw new Error(`Session creation failed (${sessionResponse.status}): ${errorText}`);
    }

    const session = await sessionResponse.json();
    sessionId = session.id;

    console.log(`  → Session ID: ${sessionId}`);

    // Connect puppeteer
    browser = await puppeteer.connect({
      browserWSEndpoint: session.connectUrl,
      defaultViewport: { width: 1920, height: 1080 }
    });

    const page = await browser.newPage();

    // Set realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigate to page
    console.log(`  → Navigating to: ${target.url}`);
    await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // Check for challenge
    const title = await page.title();
    console.log(`  → Page title: ${title}`);

    if (title.toLowerCase().includes("moment") ||
        title.toLowerCase().includes("challenge")) {
      console.log(`  ⚠️ Cloudflare challenge detected, waiting...`);
      const passed = await waitForChallenge(page, 90000);

      if (!passed) {
        throw new Error("Cloudflare challenge not passed");
      }
    }

    // Wait for video player to load
    console.log(`  → Waiting for content...`);
    await new Promise(r => setTimeout(r, 5000));

    // Debug info
    const pageInfo = await page.evaluate(() => {
      return {
        title: document.title,
        bodyPreview: (document.body?.innerText || "").substring(0, 200),
        iframes: Array.from(document.querySelectorAll('iframe')).length,
        videos: document.querySelectorAll('video').length
      };
    });

    console.log(`  → Title: ${pageInfo.title}`);
    console.log(`  → Body: ${pageInfo.bodyPreview.substring(0, 100)}...`);
    console.log(`  → Iframes: ${pageInfo.iframes}, Videos: ${pageInfo.videos}`);

    // Try to extract M3U8
    let m3u8Url = null;

    for (let i = 0; i < 30 && !m3u8Url; i++) {
      const html = await page.content();
      m3u8Url = extractM3u8FromHtml(html);

      if (!m3u8Url) {
        if (i % 10 === 0) {
          console.log(`  → Looking for M3U8... (${i}s)`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!m3u8Url) {
      const html = await page.content();
      console.log(`  ❌ No M3U8 found`);
      console.log(`  → HTML snippet: ${html.substring(0, 300)}...`);
      throw new Error("No M3U8 URL found");
    }

    console.log(`  ✓ M3U8 found: ${m3u8Url}`);

    // Update Supabase
    await updateChannelInSupabase(target.channelId, m3u8Url);

    return true;

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function main() {
  console.log("=== BROWSERBASE STREAM SYNC ===\n");

  if (!BROWSERBASE_API_KEY) {
    throw new Error("Missing BROWSERBASE_API_KEY");
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
  }

  for (const target of TARGETS) {
    console.log(`-----------------------------------------`);
    console.log(`Processing: ${target.channelId}`);

    let success = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`[Attempt ${attempt}/${MAX_RETRIES}]`);

      try {
        await processTarget(target);
        console.log(`✅ SUCCESS: ${target.channelId}\n`);
        success = true;
        break;
      } catch (error) {
        console.warn(`  ❌ Failed: ${error.message}`);

        if (attempt < MAX_RETRIES) {
          console.log(`  Retrying in 3 seconds...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    if (!success) {
      console.error(`❌ FAILED: ${target.channelId}\n`);
    }
  }

  console.log("=== ALL TARGETS PROCESSED ===");
}

main().catch((error) => {
  console.error("Workflow failed:", error.message);
  process.exitCode = 1;
});
