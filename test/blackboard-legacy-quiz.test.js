const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildLegacyReviewUrl,
  isReviewableQuizAssessment,
  parseLegacyReviewHtml,
  renderLegacyReviewHtml,
  renderLegacyReviewText,
} = require("../src/adapters/blackboard/blackboard-legacy-quiz");

test("distinguishes question assessments from file-submission assignments sharing the same handler", () => {
  assert.equal(
    isReviewableQuizAssessment("resource/x-bb-asmt-test-link", {
      type: "Test",
      hasAnswerableQuestions: true,
      questionCount: 3,
    }),
    true
  );
  assert.equal(
    isReviewableQuizAssessment("resource/x-bb-asmt-test-link", {
      type: "Test",
      subtype: "Assignment",
      hasAnswerableQuestions: false,
      hasPresentationOnlyQuestions: false,
      questionCount: 0,
    }),
    false
  );
  assert.equal(isReviewableQuizAssessment("resource/x-bb-asmt-test-link", {}), true);
  assert.equal(isReviewableQuizAssessment("resource/x-bb-assignment", { questionCount: 10 }), false);
});

test("builds a Classic review URL entirely from generic assessment identifiers", () => {
  const url = new URL(
    buildLegacyReviewUrl({
      base: "https://blackboard.example.edu",
      courseId: "_10_1",
      contentId: "_20_1",
      gradeId: "_30_1",
      columnId: "_40_1",
      attemptId: "_50_1",
    })
  );
  assert.equal(url.pathname, "/webapps/assessment/review/review.jsp");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    attempt_id: "_50_1",
    course_id: "_10_1",
    content_id: "_20_1",
    outcome_id: "_30_1",
    outcome_definition_id: "_40_1",
    takeTestContentId: "_20_1",
  });
});

test("parses localized review sections without relying on their label text", () => {
  const html = `
    <div id="pageTitleText">Review submission</div>
    <div class="infoListWrapper"><table class="key-valueTable">
      <tr><th><span class="label">Test</span></th><td>Sample quiz</td></tr>
    </table></div>
    <ul id="content_listContainer"><li id="contentListItem:_60_1">
      <div class="item"><h3>Item 1</h3></div>
      <div class="contentListRight"><p class="taskbuttondiv">1 of 1</p></div>
      <div class="details"><table>
        <tr><td><a id="question_1"></a></td></tr>
        <tr><td><img id="gs_q1" src="/images/grade-correct.gif" alt="Correct"></td>
          <td><div class="vtbegenerated"><p onclick="bad()">Which answer?</p><script>secret()</script></div>
          <table>
            <tr><td><span class="label">Chosen:</span></td><td><div class="reviewQuestionsAnswerDiv"><span class="answerTextSpan"><p>B</p></span></div></td></tr>
            <tr><td><span class="label">Options:</span></td><td><div class="reviewQuestionsAnswerDiv"><span class="answerTextSpan"><p>A</p></span></div></td></tr>
            <tr><td></td><td><div class="reviewQuestionsAnswerDiv"><span class="correctAnswerFlag"></span><span class="answerTextSpan"><p>B</p></span></div></td></tr>
          </table></td></tr>
      </table></div>
    </li></ul>`;

  const review = parseLegacyReviewHtml(html, "https://blackboard.example.edu/review.jsp?ticket=secret");
  assert.equal(review.questionCount, 1);
  assert.equal(review.questions[0].prompt.text, "Which answer?");
  assert.deepEqual(
    review.questions[0].answerSections.map((section) => [section.label, section.answers.length]),
    [["Chosen:", 1], ["Options:", 2]]
  );
  assert.equal(review.questions[0].answerSections[1].answers[1].markedCorrect, true);
  assert.doesNotMatch(review.questions[0].prompt.html, /script|onclick|secret/i);
  assert.equal(review.sourceUrl, "https://blackboard.example.edu/review.jsp?ticket=secret");
  assert.match(renderLegacyReviewText(review), /Which answer\?/);
  assert.doesNotMatch(renderLegacyReviewHtml(review), /onclick|secret\(\)/i);
});

test("rejects login and unrelated HTML instead of archiving it as a quiz", () => {
  assert.throws(
    () => parseLegacyReviewHtml("<html><title>Sign in</title><form></form></html>", "https://blackboard.example.edu/login"),
    /not a Blackboard Classic quiz review page/
  );
});
