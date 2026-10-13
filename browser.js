
const puppeteer = require("puppeteer-core");

async function main() {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;

  if (!accountId || !token) {
    throw new Error("Missing Cloudflare GitHub Secrets");
  }

  const endpoint =
    `wss://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/browser-run/devtools/browser?keep_alive=600000`;

  let browser;

  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const page = await browser.newPage();

    await page.goto("https://playsza.st/uembed.php?id=star3in", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    console.log("Browser Run connected successfully");
    console.log("Page title:", await page.title());
    console.log("Page URL:", page.url());
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((error) => {
  console.error("Browser Run test failed:", error.message);
  process.exitCode = 1;
});
