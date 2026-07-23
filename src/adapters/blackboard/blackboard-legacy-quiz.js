const cheerio = require("cheerio");

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "label",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);
const GLOBAL_ATTRIBUTES = new Set(["title"]);
const TAG_ATTRIBUTES = {
  a: new Set(["href"]),
  img: new Set(["alt", "height", "src", "width"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
};

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeResourceUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeFragment(fragmentHtml, base) {
  const fragment = cheerio.load(`<div id="archive-root">${fragmentHtml || ""}</div>`, null, false);
  const root = fragment("#archive-root");
  root.find("script,style,iframe,object,embed,form,input,button,textarea,select,link,meta").remove();
  root.find("*").each((_, element) => {
    const tag = String(element.name || "").toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      fragment(element).replaceWith(fragment(element).contents());
      return;
    }
    const allowed = TAG_ATTRIBUTES[tag] || new Set();
    for (const attribute of Object.keys(element.attribs || {})) {
      if (!GLOBAL_ATTRIBUTES.has(attribute) && !allowed.has(attribute)) {
        fragment(element).removeAttr(attribute);
      }
    }
    for (const attribute of ["href", "src"]) {
      const value = fragment(element).attr(attribute);
      if (!value) continue;
      const safeUrl = safeResourceUrl(value, base);
      if (safeUrl) fragment(element).attr(attribute, safeUrl);
      else fragment(element).removeAttr(attribute);
    }
  });
  return root.html()?.trim() || "";
}

function sanitizedContent(fragmentHtml, base) {
  const html = sanitizeFragment(fragmentHtml, base);
  const fragment = cheerio.load(html, null, false);
  return { html, text: cleanText(fragment.root().text()) };
}

function buildLegacyReviewUrl({ base, courseId, contentId, gradeId, columnId, attemptId }) {
  const required = { courseId, contentId, gradeId, columnId, attemptId };
  for (const [name, value] of Object.entries(required)) {
    if (!String(value || "").trim()) throw new Error(`Missing ${name} for Classic quiz review URL`);
  }
  const url = new URL("/webapps/assessment/review/review.jsp", base);
  for (const [name, value] of Object.entries({
    attempt_id: attemptId,
    course_id: courseId,
    content_id: contentId,
    outcome_id: gradeId,
    outcome_definition_id: columnId,
    takeTestContentId: contentId,
  })) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function isReviewableQuizAssessment(contentHandler, assessment = {}) {
  if (contentHandler !== "resource/x-bb-asmt-test-link") return false;
  const questionCount = Number(assessment.questionCount);
  const normalizedQuestionCount = Number.isFinite(questionCount) ? questionCount : null;
  const hasQuestionContent =
    assessment.hasAnswerableQuestions === true ||
    assessment.hasPresentationOnlyQuestions === true ||
    (normalizedQuestionCount !== null && normalizedQuestionCount > 0);
  if (/assignment/i.test(String(assessment.subtype || "")) && !hasQuestionContent) return false;
  if (
    assessment.hasAnswerableQuestions === false &&
    assessment.hasPresentationOnlyQuestions !== true &&
    normalizedQuestionCount === 0
  ) {
    return false;
  }
  return true;
}

function ownRowLabel($, row) {
  const firstCell = $(row).children("th,td").first();
  return cleanText(firstCell.children(".label").first().text());
}

function parseLegacyReviewHtml(html, sourceUrl) {
  const $ = cheerio.load(String(html || ""));
  const pageTitle = cleanText($("#pageTitleText").first().text() || $("title").first().text());
  const infoTable = $(".infoListWrapper table.key-valueTable").first();
  const questionItems = $("#content_listContainer > li");
  if (!infoTable.length || !$("#content_listContainer").length) {
    throw new Error("Response was not a Blackboard Classic quiz review page");
  }

  const metadata = [];
  infoTable.find("tr").each((_, row) => {
    const label = cleanText($(row).find("th .label").first().text() || ownRowLabel($, row));
    const valueCell = $(row).children("td").first();
    if (!label || !valueCell.length) return;
    const content = sanitizedContent(valueCell.html(), sourceUrl);
    metadata.push({
      label,
      text: content.text,
      html: content.html,
    });
  });

  const questions = [];
  questionItems.each((index, item) => {
    const question = $(item);
    const details = question.children(".details").first();
    const questionAnchor = details.find('a[id^="question_"]').first();
    const promptRow = questionAnchor.length ? questionAnchor.closest("tr").nextAll("tr").first() : null;
    let prompt = promptRow?.children("td").eq(1).find(".vtbegenerated").first();
    if (!prompt?.length) {
      prompt = details
        .find(".vtbegenerated")
        .filter((_, element) => !$(element).closest(".reviewQuestionsAnswerDiv").length)
        .first();
    }

    const answerSections = [];
    let currentSection = null;
    details.find(".reviewQuestionsAnswerDiv").each((_, answerElement) => {
      const answer = $(answerElement);
      const row = answer.closest("tr");
      const label = ownRowLabel($, row);
      if (label || !currentSection) {
        currentSection = { label: label || null, answers: [] };
        answerSections.push(currentSection);
      }
      const answerContent = answer.find(".answerTextSpan").first();
      const content = sanitizedContent(answerContent.html() || answer.html(), sourceUrl);
      currentSection.answers.push({
        text: content.text,
        html: content.html,
        markedCorrect: answer.find(".correctAnswerFlag").length > 0,
      });
    });

    const detailSections = [];
    details.find("tr").each((_, row) => {
      const label = ownRowLabel($, row);
      if (!label || $(row).find(".reviewQuestionsAnswerDiv").length) return;
      const cells = $(row).children("td,th");
      const valueCell = cells.eq(1);
      if (!valueCell.length) return;
      const content = sanitizedContent(valueCell.html(), sourceUrl);
      if (!content.text) return;
      detailSections.push({
        label,
        text: content.text,
        html: content.html,
      });
    });

    const resultIcon = details.find('img[id^="gs_q"]').first();
    const resultIconSource = resultIcon.attr("src") || "";
    const promptContent = sanitizedContent(prompt?.html(), sourceUrl);
    questions.push({
      index: index + 1,
      id: String(question.attr("id") || "").replace(/^contentListItem:/, "") || null,
      label: cleanText(question.children(".item").find("h3").first().text()) || `Question ${index + 1}`,
      points: cleanText(question.children(".contentListRight").find(".taskbuttondiv").first().text()) || null,
      result: cleanText(resultIcon.attr("alt") || resultIcon.attr("title")) || null,
      markedCorrect: /grade-correct/i.test(resultIconSource) && !/incorrect/i.test(resultIconSource),
      prompt: {
        text: promptContent.text,
        html: promptContent.html,
      },
      answerSections,
      detailSections,
    });
  });

  return {
    schemaVersion: 1,
    sourceUrl: String(sourceUrl || ""),
    pageTitle,
    metadata,
    questionCount: questions.length,
    questions,
  };
}

function renderLegacyReviewText(review) {
  const lines = [review.pageTitle, ""];
  for (const item of review.metadata) lines.push(`${item.label}: ${item.text}`);
  for (const question of review.questions) {
    lines.push("", question.label);
    if (question.points) lines.push(question.points);
    if (question.result) lines.push(question.result);
    lines.push(question.prompt.text);
    for (const section of question.answerSections) {
      if (section.label) lines.push(`${section.label}:`);
      for (const answer of section.answers) {
        lines.push(`- ${answer.markedCorrect ? "[correct] " : ""}${answer.text}`);
      }
    }
    for (const section of question.detailSections) lines.push(`${section.label}: ${section.text}`);
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderLegacyReviewHtml(review) {
  const metadata = review.metadata
    .map((item) => `<dt>${escapeHtml(item.label)}</dt><dd>${item.html || escapeHtml(item.text)}</dd>`)
    .join("\n");
  const questions = review.questions
    .map((question) => {
      const answers = question.answerSections
        .map(
          (section) =>
            `${section.label ? `<h3>${escapeHtml(section.label)}</h3>` : ""}<ul>${section.answers
              .map(
                (answer) =>
                  `<li${answer.markedCorrect ? ' data-marked-correct="true"' : ""}>${
                    answer.markedCorrect ? '<strong>[correct]</strong> ' : ""
                  }${answer.html || escapeHtml(answer.text)}</li>`
              )
              .join("")}</ul>`
        )
        .join("\n");
      const details = question.detailSections
        .map((section) => `<h3>${escapeHtml(section.label)}</h3>${section.html || `<p>${escapeHtml(section.text)}</p>`}`)
        .join("\n");
      return `<section><h2>${escapeHtml(question.label)}</h2>${
        question.points ? `<p>${escapeHtml(question.points)}</p>` : ""
      }${question.result ? `<p>${escapeHtml(question.result)}</p>` : ""}<div>${
        question.prompt.html || escapeHtml(question.prompt.text)
      }</div>${answers}${details}</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(review.pageTitle)}</title></head>
<body><main><h1>${escapeHtml(review.pageTitle)}</h1><dl>${metadata}</dl>${questions}</main></body>
</html>
`;
}

module.exports = {
  buildLegacyReviewUrl,
  isReviewableQuizAssessment,
  parseLegacyReviewHtml,
  renderLegacyReviewHtml,
  renderLegacyReviewText,
};
