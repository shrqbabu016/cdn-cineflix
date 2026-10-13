const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TABLE_NAME = "live_channels";
const REFERER = "https://playsza.st/";

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

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

// Fetch rendered HTML using Cloudflare Browser Run Content API
async function fetchRenderedHtml(targetUrl) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    throw new Error("Missing CF_ACCOUNT_ID or CF_API_TOKEN");
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-run/content`;

  console.log(`  → Fetching rendered HTML via Cloudflare Content API...`);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: targetUrl,
      gotoOptions: {
        waitUntil: "networkidle0"  // Wait for JS to fully execute
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloudflare API failed (${response.status}): ${errorText}`);
  }

  const html = await response.text();
  console.log(`  → HTML received: ${html.length} chars`);

  return html;
}

async function processTarget(target) {
  console.log(`  → Target: ${target.url}`);

  // Fetch rendered HTML
  const html = await fetchRenderedHtml(target.url);

  // Check if still on challenge page
  if (html.includes("Just a moment") ||
      html.includes("Checking your browser") ||
      html.includes("security verification")) {
    console.log(`  ⚠️ Cloudflare challenge still present in HTML`);
    throw new Error("Cloudflare challenge not passed");
  }

  // Extract M3U8
  const m3u8Url = extractM3u8FromHtml(html);

  if (!m3u8Url) {
    console.log(`  ❌ No M3U8 found in HTML`);
    // Debug: show snippet
    console.log(`  → HTML snippet: ${html.substring(0, 500)}...`);
    throw new Error("No M3U8 URL found");
  }

  console.log(`  ✓ M3U8 found: ${m3u8Url}`);

  // Update Supabase
  await updateChannelInSupabase(target.channelId, m3u8Url);

  return true;
}

async function main() {
  console.log("=== CLOUDFLARE CONTENT API STREAM SYNC ===\n");

  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    throw new Error("Missing CF_ACCOUNT_ID or CF_API_TOKEN");
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
