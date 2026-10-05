/**
 * Organizers' custom questions for volunteers (pure: no Google services).
 *
 * An event's optional "Questions" tab has one row per question:
 *   question  the label shown on the form (also the Signups column for answers)
 *   type      text (default) · paragraph · choice · checkbox
 *   options   for choice: the choices, separated by commas or new lines
 *   required  yes / no (blank = no)
 */
var MAX_QUESTIONS = 10;
var MAX_CHOICES = 30;
var ANSWER_LIMITS = { text: 200, paragraph: 1000, choice: 200, checkbox: 3 };
var QUESTION_TYPES = {
  text: 'text', 'short answer': 'text', 'short text': 'text',
  paragraph: 'paragraph', 'long answer': 'paragraph', 'long text': 'paragraph',
  choice: 'choice', dropdown: 'choice', 'multiple choice': 'choice',
  checkbox: 'checkbox', 'yes/no': 'checkbox', 'yes or no': 'checkbox',
};

/**
 * Questions from the Questions tab's rows (objects keyed by header), in
 * order: { label, type, options, required }. Blank and repeated labels are
 * skipped; a choice without options becomes a text question.
 */
function parseQuestions_(rows) {
  var seen = {};
  var questions = [];
  rows.forEach(function (row) {
    var label = String(row.question == null ? '' : row.question).trim().replace(/\s+/g, ' ').slice(0, 100);
    if (!label || seen[label.toLowerCase()] || questions.length >= MAX_QUESTIONS) return;
    seen[label.toLowerCase()] = true;
    var type = QUESTION_TYPES[String(row.type || '').trim().toLowerCase()] || 'text';
    var options = String(row.options == null ? '' : row.options).split(/[,\n]/)
      .map(function (o) { return o.trim(); })
      .filter(function (o, i, all) { return o && all.indexOf(o) === i; })
      .slice(0, MAX_CHOICES);
    if (type === 'choice' && !options.length) type = 'text';
    questions.push({
      label: label,
      type: type,
      options: type === 'choice' ? options : [],
      required: isYes_(row.required) || /^required$/i.test(String(row.required == null ? '' : row.required).trim()),
    });
  });
  return questions;
}

/**
 * Checks a volunteer's answers ({ label: value }) against the questions.
 * Returns { ok: true, value: { label: answer } } with every question present
 * (checkboxes as "Yes" or ""), or { ok: false, fieldErrors } keyed
 * "answer:<label>".
 */
function validateAnswers_(questions, answers) {
  answers = answers && typeof answers === 'object' ? answers : {};
  var value = {};
  var fieldErrors = {};
  questions.forEach(function (q) {
    var raw = Object.prototype.hasOwnProperty.call(answers, q.label) ? answers[q.label] : '';
    var answer;
    if (q.type === 'checkbox') {
      answer = raw === true || /^(yes|true|on)$/i.test(String(raw)) ? 'Yes' : '';
    } else {
      answer = String(raw == null ? '' : raw).trim();
      if (q.type !== 'paragraph') answer = answer.replace(/\s+/g, ' ');
    }
    var key = 'answer:' + q.label;
    if (q.required && !answer) {
      fieldErrors[key] = q.type === 'checkbox' ? 'Please check this box.' : 'Please answer this question.';
    } else if (q.type === 'choice' && answer && q.options.indexOf(answer) === -1) {
      fieldErrors[key] = 'Please pick one of the choices.';
    } else if (answer.length > ANSWER_LIMITS[q.type]) {
      fieldErrors[key] = 'Must be ' + ANSWER_LIMITS[q.type] + ' characters or fewer.';
    }
    value[q.label] = answer;
  });
  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors: fieldErrors };
  return { ok: true, value: value };
}

/** The Signups column for a question's answers: its label, unless that's a built-in column. */
function answerHeader_(label, builtInHeaders) {
  var taken = builtInHeaders.some(function (h) { return h.toLowerCase() === label.toLowerCase(); });
  return taken ? label + ' (answer)' : label;
}
