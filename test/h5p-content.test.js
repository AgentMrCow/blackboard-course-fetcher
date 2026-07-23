const assert = require("node:assert/strict");
const test = require("node:test");
const {
  h5pQuestionRecords,
  renderH5pHtml,
  renderH5pText,
} = require("../src/domain/course-fetch/h5p-content");

const content = {
  questions: [
    {
      library: "H5P.TrueFalse 1.8",
      params: {
        question: "<p>A poster should include <em>every</em> detail.</p>",
        correct: "false",
        behaviour: { feedbackOnCorrect: "Correct &amp; concise." },
      },
    },
    {
      library: "H5P.MultiChoice 1.16",
      params: {
        question: "<p>Choose the best layout.</p>",
        answers: [
          { text: "<div>Clear hierarchy</div>", correct: true },
          { text: "<div>Fill every space</div>", correct: false },
        ],
      },
    },
    {
      library: "H5P.Blanks 1.14",
      params: {
        text: "Fill in the missing word",
        questions: ["A conclusion highlights the *findings/results*."],
      },
    },
  ],
};

test("H5P content renderer extracts prompts and answer definitions", () => {
  const records = h5pQuestionRecords(content);
  assert.equal(records.length, 3);
  assert.equal(records[0].prompt, "A poster should include every detail.");
  assert.deepEqual(records[0].answers, [{ text: "False", correct: true }]);
  assert.equal(records[1].answers[0].text, "Clear hierarchy");
  assert.equal(records[1].answers[0].correct, true);
  assert.equal(records[2].answers[0].text, "findings / results");
});

test("H5P content renderer creates searchable text and standalone HTML", () => {
  const input = { content, library: "H5P.QuestionSet 1.21", title: "Poster quiz" };
  const text = renderH5pText(input);
  const html = renderH5pHtml(input);
  assert.match(text, /Question 2 \(H5P\.MultiChoice 1\.16\)/);
  assert.match(text, /\[correct\] Clear hierarchy/);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Correct:<\/strong> findings \/ results/);
  assert.doesNotMatch(html, /<em>every<\/em>/);
});
