function decodeEntities(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function plainText(value) {
  return decodeEntities(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function answerText(answer) {
  return plainText(answer?.text ?? answer?.label ?? answer?.answer ?? "");
}

function blankAnswers(lines) {
  const values = [];
  for (const line of lines || []) {
    for (const match of String(line || "").matchAll(/\*([^*]+)\*/g)) {
      const accepted = match[1]
        .split("/")
        .map((value) => plainText(value.replace(/\\\//g, "/")))
        .filter(Boolean);
      if (accepted.length) values.push(accepted);
    }
  }
  return values;
}

function h5pQuestionRecords(content) {
  return (Array.isArray(content?.questions) ? content.questions : []).map((question, index) => {
    const params = question?.params || {};
    const sourceLines = Array.isArray(params.questions) ? params.questions.map(plainText).filter(Boolean) : [];
    const answers = Array.isArray(params.answers)
      ? params.answers.map((answer) => ({
          text: answerText(answer),
          correct: answer?.correct === true,
        }))
      : [];
    const correctValue =
      params.correct === true || params.correct === "true"
        ? "True"
        : params.correct === false || params.correct === "false"
          ? "False"
          : null;
    if (correctValue) answers.push({ text: correctValue, correct: true });
    for (const accepted of blankAnswers(params.questions)) {
      answers.push({ text: accepted.join(" / "), correct: true });
    }

    const prompt = plainText(
      params.question ||
      params.taskDescription ||
      params.text ||
      question?.metadata?.title ||
      `Question ${index + 1}`
    );
    const feedback = [
      params.behaviour?.feedbackOnCorrect,
      params.behaviour?.feedbackOnWrong,
    ].map(plainText).filter(Boolean);
    return {
      index: index + 1,
      type: String(question?.library || question?.metadata?.contentType || "H5P question"),
      title: plainText(question?.metadata?.title || ""),
      prompt,
      sourceLines,
      answers,
      feedback,
      subContentId: question?.subContentId || null,
    };
  });
}

function renderH5pText({ content, library, title }) {
  const questions = h5pQuestionRecords(content);
  const lines = [
    title || "H5P content",
    library ? `Library: ${library}` : null,
    `Questions: ${questions.length}`,
    "",
  ].filter((value) => value !== null);
  for (const question of questions) {
    lines.push(`Question ${question.index} (${question.type})`);
    if (question.prompt) lines.push(question.prompt);
    for (const source of question.sourceLines) {
      if (source !== question.prompt) lines.push(source);
    }
    for (const answer of question.answers) {
      lines.push(`- ${answer.correct ? "[correct] " : ""}${answer.text}`);
    }
    for (const feedback of question.feedback) lines.push(`Feedback: ${feedback}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderH5pHtml({ content, library, title }) {
  const questions = h5pQuestionRecords(content);
  const rows = questions.map((question) => {
    const sources = question.sourceLines
      .filter((source) => source !== question.prompt)
      .map((source) => `<p>${escapeHtml(source).replace(/\n/g, "<br>")}</p>`)
      .join("");
    const answers = question.answers.length
      ? `<ul>${question.answers.map((answer) =>
          `<li${answer.correct ? ' class="correct"' : ""}>${answer.correct ? "<strong>Correct:</strong> " : ""}${escapeHtml(answer.text)}</li>`
        ).join("")}</ul>`
      : "";
    const feedback = question.feedback.length
      ? `<div class="feedback">${question.feedback.map((value) => `<p>${escapeHtml(value)}</p>`).join("")}</div>`
      : "";
    return [
      "<li>",
      `<h2>Question ${question.index}</h2>`,
      `<p class="type">${escapeHtml(question.type)}</p>`,
      question.prompt ? `<p>${escapeHtml(question.prompt).replace(/\n/g, "<br>")}</p>` : "",
      sources,
      answers,
      feedback,
      "</li>",
    ].join("");
  }).join("");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title || "H5P content")}</title>`,
    "<style>body{font-family:Arial,sans-serif;line-height:1.5;max-width:960px;margin:32px auto;padding:0 20px;color:#17202a}ol{padding-left:28px}ol>li{padding:0 0 22px 8px;border-bottom:1px solid #dfe4e8;margin-bottom:22px}h1{font-size:28px}h2{font-size:19px;margin-bottom:2px}.type{color:#5f6b76;font-size:13px;margin-top:0}.correct{color:#17633a}.feedback{border-left:3px solid #8ea3b0;padding-left:12px;color:#34434d}li{margin:6px 0}</style>",
    "</head><body>",
    `<h1>${escapeHtml(title || "H5P content")}</h1>`,
    library ? `<p>Library: ${escapeHtml(library)}</p>` : "",
    `<p>${questions.length} question${questions.length === 1 ? "" : "s"}</p>`,
    `<ol>${rows}</ol>`,
    "</body></html>",
  ].join("\n");
}

module.exports = {
  h5pQuestionRecords,
  plainText,
  renderH5pHtml,
  renderH5pText,
};
