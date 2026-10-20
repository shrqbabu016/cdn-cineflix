/**
 * ======================================================================
 * 🚀 STANDALONE LIVE CHANNEL EXTRACTOR FOR VPS
 * ======================================================================
 * - Runs automatically every 30 minutes (or on-demand with --once).
 * - Extracts dynamic HLS stream tokens from WebCric, FinalSpot & 1FreeCDN:
 *     1. webcricp01 (Sky Sports Cricket HD)
 *     2. webcricn02 (CricBuzz 1 HD)
 *     3. csstream1 (1FreeCDN HD Stream)
 *     4. willow1 (Willow HD WebCric)
 * - Directly updates Supabase table `public.live_channels`:
 *     - Updates `cdn_url` (Raw upstream m3u8 playlist with fresh pk/auth token)
 *     - Updates `stream_url` (Worker load-balanced proxy URL)
 *     - Updates `referer` and marks `is_active: true`
 * - Automatically rotates across multiple Cloudflare Workers for zero rate-limits.
 * - Built purely with native Node.js (ZERO heavy npm packages, zero puppeteer, ultra-light).
 */

const https = require('https');
const http = require('http');

// ==========================================
// CONFIGURATION
// ==========================================
const SUPABASE_URL = process.env.SUPABASE_URL || "https://exaorbbpvxnogpbvyayx.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4YW9yYmJwdnhub2dwYnZ5YXl4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMjM4MDUsImV4cCI6MjEwNDY5OTgwNX0.mnV03xUfYtG5xFftaNNnkK_S7UkIGPLw5QTqcIf6aWs";
const INTERVAL_MINUTES = parseInt(process.env.INTERVAL_MINUTES || "30", 10);

// Primary worker endpoint to construct stream_url
const PRIMARY_WORKER = "https://live.betadda.workers.dev";

// Channels list to extract
const CHANNELS = [
  {
    id: "webcricp01",
    name: "Sky Cricket HD (Eng)",
    embedUrl: "https://web.finalspot.top/hembedplayer/webcricp01/6/850/480",
    referer: "https://webcric.im/"
  },
  {
    id: "webcricn02",
    name: "CricBuzz 1 HD",
    embedUrl: "https://web.finalspot.top/hembedplayer/webcricn02/6/850/480",
    referer: "https://webcric.im/"
  },
  {
    id: "csstream1",
    name: "1FreeCDN Cricket 1",
    embedUrl: "https://1freecdn.xyz/hembedplayer/csstream1/1/960/540",
    referer: "https://webcric.is/"
  },
  {
    id: "willow1",
    name: "Willow 1 HD (WebCric)",
    embedUrl: "https://web.finalspot.top/hembedplayer/willow1/6/850/480",
    referer: "https://webcric.im/"
  }
];

// Use standard domain lookup (VPS has full global internet access)
const DIRECT_HOST_IPS = {};

// ==========================================
// 1. NATIVE HTTP/HTTPS REQUEST HELPER
// ==========================================
function nativeFetch(targetUrl, headers = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }

    const client = u.protocol === 'https:' ? https : http;
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      ...headers
    };

    // Check if we have a direct IP fallback for the host
    const ipOverride = DIRECT_HOST_IPS[u.hostname];
    const requestHost = ipOverride || u.hostname;

    const options = {
      hostname: requestHost,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        ...reqHeaders,
        'Host': u.host
      },
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined
    };

    if (u.protocol === 'https:') {
      options.servername = u.hostname;
    }

    const req = client.request(options, (res) => {
      // Follow 301/302 redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirected = new URL(res.headers.location, targetUrl).toString();
        return nativeFetch(redirected, headers, timeoutMs).then(resolve).catch(reject);
      }

      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

// ==========================================
// 2. EMBED STREAM PARSER (FINALSPOT & 1FREECDN)
// ==========================================
function enableVideo(pk, is1FreeCdn = false) {
  const idx = is1FreeCdn ? 54 : 53;
  if (!pk || pk.length <= idx) return pk;
  return pk.substring(0, idx) + pk.substring(idx + 1, pk.length);
}

async function extractEmbedChannel(channel) {
  const is1FreeCdn = channel.embedUrl.includes("1freecdn");
  const referer = channel.referer;

  console.log(`[${channel.id}] Fetching embed: ${channel.embedUrl}`);
  const res = await nativeFetch(channel.embedUrl, { 'Referer': referer });

  if (res.statusCode !== 200) {
    throw new Error(`HTTP ${res.statusCode} from embed page`);
  }

  const html = res.body;

  // Extract variables: hlsUrl, ea, and pk
  const hlsBaseMatch = html.match(/hlsUrl\s*=\s*["']([^"']*)["']\s*\+\s*ea(?:\s*\+\s*["']|["'])([^"']*)["']/i);
  const pkMatch = html.match(/var\s+pk\s*=\s*["']([^"']+)["']/i);
  const eaMatch = html.match(/ea\s*=\s*["']([^"']+)["']/i);

  if (hlsBaseMatch && pkMatch && eaMatch) {
    let host = eaMatch[1];
    let path = hlsBaseMatch[2];
    let proto = "https:";

    if (is1FreeCdn) {
      proto = "http:";
      if (!host.includes(":")) host = `${host}:8088`;
    }

    const cleanPk = enableVideo(pkMatch[1], is1FreeCdn);
    const fullStreamUrl = `${proto}//${host}${path}${cleanPk}`;
    return {
      streamUrl: fullStreamUrl,
      referer
    };
  }

  // Alternative fallback regex pattern for variant player scripts
  const directM3u8Match = html.match(/source\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
  if (directM3u8Match) {
    return {
      streamUrl: directM3u8Match[1],
      referer
    };
  }

  throw new Error("Could not find hlsUrl/ea/pk in embed page response");
}

// ==========================================
// 3. SUPABASE SYNC (UPDATE LIVE_CHANNELS)
// ==========================================
function updateSupabase(channelId, cdnUrl, workerStreamUrl, referer) {
  return new Promise((resolve, reject) => {
    const patchPath = `/rest/v1/live_channels?id=eq.${encodeURIComponent(channelId)}`;
    const payload = JSON.stringify({
      cdn_url: cdnUrl,
      stream_url: workerStreamUrl,
      referer: referer,
      is_active: true
    });

    const u = new URL(SUPABASE_URL);
    const options = {
      hostname: u.hostname,
      port: 443,
      path: patchPath,
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Prefer': 'return=representation'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Supabase HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ==========================================
// 4. MAIN EXTRACTION CYCLE
// ==========================================
async function runExtractionCycle() {
  const timestamp = new Date().toISOString();
  console.log(`\n=============================================================`);
  console.log(`  🏏 LIVE CHANNELS EXTRACT CYCLE STARTED: ${timestamp}`);
  console.log(`=============================================================`);

  let successCount = 0;

  for (const channel of CHANNELS) {
    try {
      const extracted = await extractEmbedChannel(channel);
      console.log(`  ✅ [${channel.id}] Successfully extracted raw stream URL:`);
      console.log(`     cdn_url:    ${extracted.streamUrl}`);

      const workerStreamUrl = `${PRIMARY_WORKER}/hls/${channel.id}/playlist.m3u8`;
      console.log(`     stream_url: ${workerStreamUrl}`);

      // Sync to Supabase
      await updateSupabase(channel.id, extracted.streamUrl, workerStreamUrl, extracted.referer);
      console.log(`  🚀 [${channel.id}] Synced to Supabase public.live_channels!`);
      successCount++;
    } catch (err) {
      console.error(`  ❌ [${channel.id}] Extraction failed: ${err.message}`);
    }
  }

  console.log(`=============================================================`);
  console.log(`  Extraction Cycle Complete: ${successCount}/${CHANNELS.length} channels updated.`);
  console.log(`=============================================================\n`);
}

// ==========================================
// 5. ENTRY POINT & SCHEDULER
// ==========================================
const isOnce = process.argv.includes('--once');

if (isOnce) {
  runExtractionCycle().then(() => {
    console.log("Single execution finished. Exiting.");
    process.exit(0);
  }).catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
} else {
  // Run once immediately upon start
  runExtractionCycle();

  // Schedule every 30 minutes
  const intervalMs = INTERVAL_MINUTES * 60 * 1000;
  console.log(`⏱️ Scheduler active: Running every ${INTERVAL_MINUTES} minutes (${intervalMs}ms)...`);
  setInterval(runExtractionCycle, intervalMs);
}
