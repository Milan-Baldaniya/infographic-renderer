const express = require("express");
const path = require("path");
const fs = require("fs");

// Detect if we are running in a serverless environment (Vercel)
const isProduction = process.env.NODE_ENV === 'production';

let puppeteer;
let chromium;

if (isProduction) {
  puppeteer = require("puppeteer-core");
  chromium = require("@sparticuz/chromium");
} else {
  puppeteer = require("puppeteer");
}

const app = express();
app.use(express.text({ type: "*/*", limit: "5mb" }));

const imagesDir = isProduction ? path.join('/tmp', 'images') : path.join(process.cwd(), 'public', 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}
app.use('/images', express.static(imagesDir));

// Read and base64-encode the logo for inline embedding
const logoPath = path.join(process.cwd(), 'assets', 'logo.png'); // Use process.cwd() for Vercel
let logoBase64 = '';
try {
  const logoBuffer = fs.readFileSync(logoPath);
  logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;
} catch (e) {
  console.warn('⚠️  Logo file not found at assets/logo.png');
}

app.post("/render", async (req, res) => {
  let data;
  try {
    data = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).send("Invalid JSON");
  }
  if (!data || !data.sections) {
    return res.status(400).send("Missing sections in layout data");
  }

  let browser;
  try {
    if (isProduction) {
      // Vercel / Production Launch
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    } else {
      // Local Development Launch
      browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
    }

    const page = await browser.newPage();
    const html = generateHTML(data);
    await page.setViewport({ width: 1080, height: 1080 });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);
    // await new Promise(r => setTimeout(r, 500)); // Remove arbitrary wait for speed

    const buffer = await page.screenshot({ type: "png" });
    await browser.close();

    const timestamp = Date.now();
    const filename = `infographic-${timestamp}.png`;
    const filepath = path.join(imagesDir, filename);
    
    fs.writeFileSync(filepath, buffer);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const imageUrl = `${protocol}://${host}/images/${filename}`;

    // Provide both the URL and the image (as base64 text) in the JSON response
    const imageBase64 = buffer.toString('base64');

    res.status(200).json({ 
      image_url: imageUrl,
      image_base64: `data:image/png;base64,${imageBase64}`
    });
  } catch (error) {
    console.error("Error generating image:", error);
    res.status(500).send("Error generating image");
    if (browser) await browser.close();
  }
});

// ─────────────────────────────────────────────────
// RENDER SECTIONS
// ─────────────────────────────────────────────────
function renderSections(data) {
  const validLayouts = ['mindmap', 'neural', 'geometric'];
  if (!data.layout || !validLayouts.includes(data.layout)) {
    data.layout = 'mindmap';
  }

  const sections = data.sections.slice(0, 6);
  const sectionCount = sections.length;

  // Determine grid: 2 cols for <=4 sections, 3 cols for 5-6
  const cols = sectionCount <= 4 ? 2 : 3;

  // ── Branding (right side of header) ──
  const brandingHTML = `
    <div class="branding">
      ${logoBase64 ? `<img class="brand-logo" src="${logoBase64}" alt="Logo" />` : ''}
      <span class="brand-name"><span style="color:#1987fa;font-weight:800;">Scholar</span> <span style="color:#81d12c;font-weight:800;">Clone</span></span>
    </div>
  `;

  // ── Connector arrow SVG ──
  const connectorArrow = `
    <svg class="connector-arrow" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 4 L12 16 M7 12 L12 17 L17 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;

  // ── Build card rows with connector arrows between rows ──
  const rows = [];
  for (let i = 0; i < sectionCount; i += cols) {
    const rowSections = sections.slice(i, i + cols);

    // Add connector arrow between card rows
    if (i > 0) {
      rows.push(`<div class="connector-row">${connectorArrow}</div>`);
    }

    rows.push(`
      <div class="card-row" style="grid-template-columns: repeat(${rowSections.length}, 1fr);">
        ${rowSections.map((section, j) => {
      const globalIdx = i + j;
      const number = String(globalIdx + 1).padStart(2, '0');
      const pointCount = section.points.length;
      const totalChars = section.heading.length + section.points.join('').length;
      // Density classification
      let density;
      if (pointCount <= 2 && totalChars < 80) density = 'density-low';
      else if (pointCount >= 5 || totalChars > 200) density = 'density-high';
      else density = 'density-medium';
      return `
            <div class="card ${density}">
              <div class="card-header-row">
                <span class="card-number">${number}.</span>
                <h3 class="card-heading">${section.heading}</h3>
              </div>
              <ul class="card-points">
                ${section.points.map(p => `<li>${p}</li>`).join('')}
              </ul>
            </div>
          `;
    }).join('')}
      </div>
    `);
  }

  return `
    <div class="infographic layout-${data.layout}">
      <div class="header">
        <div class="header-left">
          <h1 class="title">${data.title}</h1>
          <p class="subtitle">${data.subtitle}</p>
        </div>
        ${brandingHTML}
      </div>

      <div class="cards-container">
        ${rows.join('')}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────
// GENERATE HTML
// ─────────────────────────────────────────────────
function generateHTML(data) {
  const cssFiles = ['base.css', 'mindmap.css', 'neural.css', 'geometric.css'];
  const cssContent = cssFiles.map(file => {
    try {
      // Use process.cwd() for Vercel compatibility
      return fs.readFileSync(path.join(process.cwd(), 'public/css', file), 'utf8');
    } catch (e) {
      console.warn(`⚠️  CSS file not found: ${file}`);
      return '';
    }
  }).join('\n');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    ${cssContent}
  </style>
</head>
<body>
  ${renderSections(data)}
</body>
</html>
  `;
}

app.listen(3000, () => console.log("✅ Renderer running on port 3000"));
