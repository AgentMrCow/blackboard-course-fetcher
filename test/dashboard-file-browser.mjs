import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { serveArchiveFile, serveStaticFile } from "../src/adapters/http/file-responses.js";
import { mimeType } from "../src/domain/archive/archive-metadata.js";

// Real HTTP responses are essential here: mocked routes do not exercise the
// archive response CSP. Every document and API response is synthetic and local.
const directory = await mkdtemp(path.join(os.tmpdir(), "archive-browser-security-"));
let probes = 0;
let checks = 0;
let browser;
const failures = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/probe") {
    probes += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"synthetic":true}');
    return;
  }
  const name = url.pathname.slice(1);
  if (!["active.svg", "active.html", "ordinary.svg", "ordinary.pdf", "preview.html"].includes(name)) {
    response.writeHead(404); response.end(); return;
  }
  const serve = name === "preview.html" ? serveStaticFile : serveArchiveFile;
  serve({ request, response, file: path.join(directory, name), mimeType }).catch((error) => {
    failures.push(error.message);
    if (!response.headersSent) { response.writeHead(error.statusCode || 500); response.end("Synthetic file error"); }
    else response.destroy();
  });
});

function syntheticPdf() {
  const stream = "0.1 0.6 0.4 rg 40 40 220 220 re f\nBT /F1 20 Tf 40 290 Td (Synthetic PDF preview) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 360] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function check(name, operation) {
  await operation(); checks += 1; console.log(`PASS ${name}`);
}

async function eventually(operation) {
  let failure;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return await operation(); } catch (error) { failure = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw failure;
}

async function assertPdfViewer(page) {
  const viewer = await eventually(() => {
    const frame = page.frames().find((item) => item.url().startsWith("chrome-extension://"));
    assert.ok(frame, "Chromium must open its PDF viewer");
    return frame;
  });
  const pageNumber = viewer.getByRole("textbox", { name: "Page number" });
  await pageNumber.waitFor({ state: "visible" });
  assert.equal(await pageNumber.inputValue(), "1");
  assert.equal(await viewer.getByRole("tab", { name: "Thumbnail for page 1" }).isVisible(), true);
  const zoom = viewer.getByRole("textbox", { name: "Zoom level" });
  const before = await zoom.inputValue();
  await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
  await eventually(async () => assert.notEqual(await zoom.inputValue(), before));
}

try {
  const attack = "window.__archiveScriptRan = true; fetch('/probe');";
  await Promise.all([
    writeFile(path.join(directory, "active.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><script>${attack}</script><rect id="visible" width="300" height="100" fill="#14966d"/></svg>`),
    writeFile(path.join(directory, "active.html"), `<html><body><h1>Safe archived content</h1><script>${attack}</script></body></html>`),
    writeFile(path.join(directory, "ordinary.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect id="visible" width="300" height="100" fill="#14966d"/><text x="20" y="55" fill="white">Synthetic diagram</text></svg>'),
    writeFile(path.join(directory, "ordinary.pdf"), syntheticPdf()),
    writeFile(path.join(directory, "preview.html"), '<!doctype html><html><body><iframe src="/ordinary.pdf" title="Synthetic PDF preview" style="width:900px;height:700px"></iframe></body></html>'),
  ]);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Full Chromium includes the built-in PDF viewer; headless-shell cannot test it.
  browser = await chromium.launch({ headless: true, channel: "chromium" });
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await context.newPage();

  for (const name of ["active.svg", "active.html"]) {
    await check(`direct ${name} navigation blocks archive scripts and same-origin API access`, async () => {
      const response = await page.goto(`${origin}/${name}`, { waitUntil: "networkidle" });
      assert.equal(response.status(), 200);
      assert.match(response.headers()["content-security-policy"], /^sandbox;/);
      assert.equal(await page.evaluate(() => window.__archiveScriptRan), undefined);
      assert.equal(probes, 0);
      // Even automation-injected code cannot use this document as an API origin.
      const canReadApi = await page.evaluate(async () => {
        try { await fetch("/probe"); return true; } catch { return false; }
      });
      assert.equal(canReadApi, false);
      assert.equal(probes, 0);
      if (name.endsWith(".html")) assert.equal(await page.getByRole("heading", { name: "Safe archived content" }).isVisible(), true);
    });
  }

  await check("ordinary SVG still renders visible geometry and text", async () => {
    await page.goto(`${origin}/ordinary.svg`);
    const shape = page.locator("#visible");
    assert.equal(await shape.isVisible(), true);
    const bounds = await shape.boundingBox();
    assert.equal(bounds.width, 300);
    assert.equal(bounds.height, 100);
    assert.equal(await shape.evaluate((element) => getComputedStyle(element).fill), "rgb(20, 150, 109)");
    assert.equal(await page.getByText("Synthetic diagram").isVisible(), true);
  });

  await check("ordinary PDF loads its page and supports zoom in the built-in viewer", async () => {
    const response = await page.goto(`${origin}/ordinary.pdf`, { waitUntil: "networkidle" });
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["content-type"], "application/pdf");
    // Chrome replaces the navigation response with its PDF extension response;
    // inspect the actual HTTP headers independently of that internal document.
    const headers = await context.request.head(`${origin}/ordinary.pdf`);
    assert.match(headers.headers()["content-security-policy"], /^sandbox;/);
    await assertPdfViewer(page);
  });

  await check("PDF preview also works inside the dashboard's static-page CSP", async () => {
    await page.goto(`${origin}/preview.html`, { waitUntil: "networkidle" });
    assert.equal(await page.getByTitle("Synthetic PDF preview").isVisible(), true);
    await assertPdfViewer(page);
  });
  assert.deepEqual(failures, []);
  assert.equal(probes, 0);
  console.log(`Archive file browser checks passed: ${checks}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
