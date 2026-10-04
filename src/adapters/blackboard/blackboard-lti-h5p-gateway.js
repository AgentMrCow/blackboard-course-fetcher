const path = require("path");
const cheerio = require("cheerio");
const {
  isH5pLti,
  ltiProviderHost,
} = require("../../domain/course-fetch/blackboard-lti-policy");
const {
  isBlackboardAuthenticationRedirect,
} = require("../../domain/course-fetch/blackboard-attachment-policy");

const USER_AGENT = "Mozilla/5.0 Blackboard Archive Fetcher";
const MAX_LAUNCH_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

function setCookieHeaders(response) {
  if (typeof response?.headers?.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const value = response?.headers?.get?.("set-cookie");
  return value ? [value] : [];
}

class ResponseCookieJar {
  constructor() {
    this.values = new Map();
  }

  absorb(response) {
    for (const header of setCookieHeaders(response)) {
      const pair = String(header).split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      this.values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  header(savedCookieHeader = "") {
    const values = new Map();
    for (const pair of String(savedCookieHeader || "").split(";")) {
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
    for (const [name, value] of this.values) values.set(name, value);
    return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function launchForms(html, pageUrl) {
  const $ = cheerio.load(String(html || ""));
  return $("form")
    .map((_, element) => {
      const form = $(element);
      const method = String(form.attr("method") || "GET").toUpperCase();
      const actionValue = form.attr("action");
      if (method !== "POST" || !actionValue) return null;
      const fields = {};
      form.find("input[name]").each((__, input) => {
        const name = $(input).attr("name");
        if (name) fields[name] = $(input).attr("value") || "";
      });
      return {
        actionUrl: new URL(actionValue, pageUrl).toString(),
        fields,
      };
    })
    .get()
    .filter(Boolean);
}

function parseLtiLaunchForm(html, pageUrl, expectedTargetUrl = null) {
  const forms = launchForms(html, pageUrl);
  if (forms.length === 0) throw new Error("Blackboard LTI launch page contained no POST form");
  const expectedHost = ltiProviderHost({ actionUrl: expectedTargetUrl });
  return (
    forms.find((form) =>
      expectedHost && ltiProviderHost({ actionUrl: form.actionUrl }) === expectedHost
    ) ||
    forms.find((form) => form.fields.lti_message_type || form.fields.oauth_signature) ||
    forms[0]
  );
}

function h5pScriptReferer(html, actionUrl) {
  const $ = cheerio.load(String(html || ""));
  const scripts = $("script[src]").map((_, script) => $(script).attr("src")).get().filter(Boolean);
  const selected = scripts.find((value) => /\/js\/[^/]+\.js(?:[?#]|$)/i.test(value));
  return selected ? new URL(selected, actionUrl).toString() : actionUrl;
}

function embedUrl(embedCode, base) {
  if (!embedCode) return null;
  const $ = cheerio.load(String(embedCode));
  const source = $("iframe[src]").first().attr("src");
  if (!source) return null;
  try {
    return new URL(source, base).toString();
  } catch {
    return null;
  }
}

function packageFilename(fileUrl, fallbackTitle) {
  try {
    const name = decodeURIComponent(path.basename(new URL(fileUrl).pathname));
    if (name) return name;
  } catch {}
  return `${String(fallbackTitle || "h5p-content").replace(/[^\w.-]+/g, "-")}.h5p`;
}

async function responseText(response, label) {
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`${label} failed: HTTP ${response.status} ${response.statusText} ${body.slice(0, 200)}`);
  }
  return body;
}

async function responseJson(response, label) {
  const text = await responseText(response, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON (${response.headers.get("content-type") || "unknown type"})`);
  }
}

class BlackboardLtiH5pGateway {
  constructor({ base, client, userAgent = USER_AGENT }) {
    if (!base || !client?.request || !client?.cookieHeaderFor) {
      throw new Error("BlackboardLtiH5pGateway requires base and client");
    }
    this.base = base;
    this.client = client;
    this.userAgent = userAgent;
  }

  async loadLaunchForm({ detail, launchUrl }) {
    let pageUrl = new URL(launchUrl, this.base).toString();
    let redirects = 0;
    const visited = new Set();
    const cookies = new ResponseCookieJar();
    while (true) {
      visited.add(pageUrl);
      const response = await this.client.request(
        pageUrl,
        {
          redirect: "manual",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            Cookie: cookies.header(this.client.cookieHeaderFor(pageUrl)),
            "User-Agent": this.userAgent,
          },
        },
        "Blackboard LTI launch",
        1
      );
      if (isBlackboardAuthenticationRedirect(response.url || pageUrl, this.base)) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Blackboard LTI launch redirected to authentication");
      }
      cookies.absorb(response);
      const location = response.headers.get("location");
      if (REDIRECT_STATUS_CODES.has(response.status) && location) {
        await response.body?.cancel().catch(() => {});
        const nextUrl = new URL(location, pageUrl).toString();
        if (isBlackboardAuthenticationRedirect(nextUrl, this.base)) {
          throw new Error("Blackboard LTI launch redirected to authentication or outside Blackboard");
        }
        if (visited.has(nextUrl)) throw new Error("Blackboard LTI launch encountered a redirect loop");
        if (redirects >= MAX_LAUNCH_REDIRECTS) {
          throw new Error(`Blackboard LTI launch exceeded ${MAX_LAUNCH_REDIRECTS} redirects`);
        }
        redirects += 1;
        pageUrl = nextUrl;
        continue;
      }
      const html = await responseText(response, "Blackboard LTI launch");
      return parseLtiLaunchForm(html, pageUrl, detail?.url);
    }
  }

  async exportPackage({ actionUrl, bearer, cookies, exportUrl, referer, title }) {
    if (!exportUrl || !bearer) {
      return { available: false, reason: "H5P did not advertise an authenticated package export" };
    }
    try {
      const response = await this.client.request(
        exportUrl,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Cookie: cookies.header(),
            Origin: new URL(actionUrl).origin,
            Referer: referer,
            "User-Agent": this.userAgent,
          },
          body: JSON.stringify({ fromWorker: false, bearer }),
        },
        "H5P package export",
        1
      );
      cookies.absorb(response);
      const result = await responseJson(response, "H5P package export");
      if (!result.fileURL) {
        return { available: false, reason: "H5P package export returned no file URL" };
      }
      return {
        available: true,
        exportUrl,
        fileName: packageFilename(result.fileURL, title),
        mimeType: "application/zip",
        url: result.fileURL,
      };
    } catch (error) {
      return { available: false, reason: error.message };
    }
  }

  async collect({ detail, launchUrl }) {
    const launch = await this.loadLaunchForm({ detail, launchUrl });
    const providerHost = ltiProviderHost({ actionUrl: launch.actionUrl, detail });
    if (!isH5pLti({ actionUrl: launch.actionUrl, detail })) {
      return {
        status: "unsupported",
        provider: "unknown-lti",
        providerHost,
        launchUrl,
        targetUrl: launch.actionUrl,
        resources: [],
        diagnostics: [`No content adapter is registered for ${providerHost || "this LTI provider"}`],
      };
    }

    const cookies = new ResponseCookieJar();
    const formResponse = await this.client.request(
      launch.actionUrl,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: new URL(launchUrl).origin,
          Referer: launchUrl,
          "User-Agent": this.userAgent,
        },
        body: new URLSearchParams(launch.fields).toString(),
      },
      "H5P LTI form launch",
      1
    );
    cookies.absorb(formResponse);
    const formHtml = await responseText(formResponse, "H5P LTI form launch");
    const referer = h5pScriptReferer(formHtml, launch.actionUrl);

    const contentResponse = await this.client.request(
      launch.actionUrl,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: cookies.header(),
          Origin: new URL(launch.actionUrl).origin,
          Referer: referer,
          "User-Agent": this.userAgent,
        },
        body: JSON.stringify(launch.fields),
      },
      "H5P LTI content",
      1
    );
    cookies.absorb(contentResponse);
    const payload = await responseJson(contentResponse, "H5P LTI content");
    const contentEntries = Object.entries(payload?.settings?.contents || {})
      .filter(([, value]) => value?.jsonContent);
    if (contentEntries.length === 0) {
      throw new Error("H5P LTI response contained no content JSON");
    }

    const resources = [];
    for (const [key, value] of contentEntries) {
      let content = null;
      let contentError = null;
      try {
        content = JSON.parse(value.jsonContent);
      } catch (error) {
        contentError = `Invalid H5P content JSON: ${error.message}`;
      }
      const packageResult = await this.exportPackage({
        actionUrl: launch.actionUrl,
        bearer: payload.bearer,
        cookies,
        exportUrl: value.exportUrl,
        referer,
        title: value.title,
      });
      resources.push({
        key,
        contentId: key.replace(/^cid-/, "") || null,
        title: value.title || null,
        library: value.library || null,
        metadata: value.metadata || null,
        displayOptions: value.displayOptions || null,
        contentUserStatus: value.contentUserStatus || null,
        canViewOwnReports: value.canViewOwnReports ?? null,
        isScoringEnabled: value.isScoringEnabled ?? null,
        embedUrl: embedUrl(value.embedCode, launch.actionUrl),
        scripts: Array.isArray(value.scripts) ? value.scripts : [],
        styles: Array.isArray(value.styles) ? value.styles : [],
        content,
        contentError,
        package: packageResult,
      });
    }

    return {
      status: "ready",
      provider: "h5p",
      providerHost,
      launchUrl,
      targetUrl: launch.actionUrl,
      resources,
      diagnostics: [
        `Parsed Blackboard LTI launch form with ${Object.keys(launch.fields).length} fields`,
        `Archived ${resources.length} H5P content payload(s) through authenticated HTTP`,
      ],
    };
  }
}

module.exports = {
  BlackboardLtiH5pGateway,
  ResponseCookieJar,
  h5pScriptReferer,
  parseLtiLaunchForm,
};
