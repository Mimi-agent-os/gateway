/** ask_owner in the gateway: the one parser of the questions a model asks and of the answers a device sends back. */

import {
    QUESTION_DESCRIPTION_MAX,
    QUESTION_LABEL_MAX,
    QUESTION_OPTIONS_MAX,
    QUESTION_OPTIONS_MIN,
    QUESTION_OTHER_MAX,
    QUESTION_TEXT_MAX,
    QUESTIONS_MAX,
    type OwnerAnswer,
    type OwnerOption,
    type OwnerQuestion,
} from "@mimi-os/protocol";

export const ASK_OWNER = "ask_owner";

/** The model's ask_owner arguments as questions with `multi` and `other` filled in, or what is wrong with them. */
export function parseQuestions(args: Record<string, unknown>): OwnerQuestion[] | string {
    const raw = args["questions"];
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > QUESTIONS_MAX) {
        return `questions must be a list of 1 to ${QUESTIONS_MAX} questions`;
    }
    const questions: OwnerQuestion[] = [];
    for (const [i, item] of raw.entries()) {
        const at = `questions[${i}]`;
        if (item === null || typeof item !== "object" || Array.isArray(item)) return `${at} must be an object`;
        const q = item as Record<string, unknown>;
        const question = typeof q["question"] === "string" ? q["question"].trim() : "";
        if (!question || question.length > QUESTION_TEXT_MAX) return `${at}.question must be 1 to ${QUESTION_TEXT_MAX} characters`;
        const multi = q["multi"] ?? false;
        const other = q["other"] ?? false;
        if (typeof multi !== "boolean") return `${at}.multi must be true or false`;
        if (typeof other !== "boolean") return `${at}.other must be true or false`;
        const rawOptions = q["options"];
        if (!Array.isArray(rawOptions) || rawOptions.length < QUESTION_OPTIONS_MIN || rawOptions.length > QUESTION_OPTIONS_MAX) {
            return `${at}.options must be a list of ${QUESTION_OPTIONS_MIN} to ${QUESTION_OPTIONS_MAX} options`;
        }
        const options: OwnerOption[] = [];
        const seen = new Set<string>();
        for (const [j, opt] of rawOptions.entries()) {
            const where = `${at}.options[${j}]`;
            if (opt === null || typeof opt !== "object" || Array.isArray(opt)) return `${where} must be an object`;
            const o = opt as Record<string, unknown>;
            const label = typeof o["label"] === "string" ? o["label"].trim() : "";
            if (!label || label.length > QUESTION_LABEL_MAX || /[\p{Cc}\u2028\u2029]/u.test(label)) {
                return `${where}.label must be one line of 1 to ${QUESTION_LABEL_MAX} characters`;
            }
            if (seen.has(label.toLowerCase())) return `${where}.label "${label}" repeats another option's label`;
            seen.add(label.toLowerCase());
            const rawDescription = o["description"] ?? "";
            if (typeof rawDescription !== "string" || rawDescription.trim().length > QUESTION_DESCRIPTION_MAX) {
                return `${where}.description must be text of at most ${QUESTION_DESCRIPTION_MAX} characters`;
            }
            const option: OwnerOption = { label };
            if (rawDescription.trim()) option.description = rawDescription.trim();
            options.push(option);
        }
        questions.push({ question, options, multi, other });
    }
    return questions;
}

/** A device's answers checked against the gate's own questions, picks put in the options' order, or what is wrong with them. */
export function parseAnswers(questions: readonly OwnerQuestion[], raw: unknown): OwnerAnswer[] | string {
    if (!Array.isArray(raw) || raw.length !== questions.length) {
        return `answers must be a list of ${questions.length}, one per question`;
    }
    const answers: OwnerAnswer[] = [];
    for (const [i, q] of questions.entries()) {
        const at = `answers[${i}]`;
        const item: unknown = raw[i];
        if (item === null || typeof item !== "object" || Array.isArray(item)) return `${at} must be an object`;
        const a = item as Record<string, unknown>;
        const selected: unknown = a["selected"];
        if (!Array.isArray(selected) || !selected.every((s) => typeof s === "string")) {
            return `${at}.selected must be a list of option labels`;
        }
        const picked = new Set<string>(selected);
        if (picked.size !== selected.length) return `${at}.selected names an option twice`;
        const stranger = selected.find((s) => !q.options.some((o) => o.label === s));
        if (stranger !== undefined) return `${at}.selected: "${stranger}" is not an option of this question`;
        if (selected.length > 1 && q.multi !== true) return `${at}: this question takes a single pick`;
        const rawOther = a["other"];
        if (rawOther !== undefined && typeof rawOther !== "string") return `${at}.other must be text`;
        const other = typeof rawOther === "string" ? rawOther.trim() : "";
        if (other && q.other !== true) return `${at}: this question takes no answer in the owner's own words`;
        if (other.length > QUESTION_OTHER_MAX) return `${at}.other is over ${QUESTION_OTHER_MAX} characters`;
        if (selected.length === 0 && !other) {
            return `${at}: pick ${q.multi === true ? "at least one option" : "one option"}${q.other === true ? " or answer in your own words" : ""}`;
        }
        const answer: OwnerAnswer = { selected: q.options.filter((o) => picked.has(o.label)).map((o) => o.label) };
        if (other) answer.other = other;
        answers.push(answer);
    }
    return answers;
}
