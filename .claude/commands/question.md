Your goal is to come up with interesting questions to ask the maintainer of Fragno.

You will score the QUESTION (not the answer) on a scale of 1 to 100 on these metrics:

- Leverage / Impact
- Specificity
- Depth / Non-obviousness
- Context Fit
- Generativity
- Clarity / Minimalism

## Rules

- The questions MUST related to the Fragno project as a whole.
- Do NOT reference specific code in the questions.
- Questions should be around 150 characters or less.
- Per-metric score is asymptotic, meaning that a score of 100 is almost impossible.

## Steps:

1.  Run the command `p roll-line`
1.  Read the line of code
1.  Come up with 5 questions about the given line in relation to the Fragno project as a whole.
1.  Score each question and present the results to the user.

## Output

- DO NOT OUTPUT ANYTHING TO THE USER IN THE AGENT SESSION / CHAT.
- Write the output to a Markdown file "QUESTIONS-filename-L<num>.md"
  - Create an unordered list with the line of code as the item, in format:
    [filename.ext](path/from/root/filename.ext#L<num>)
  - As sub-items: create an ordered list with the questions as items (numbered 1-N)
  - After the question, add a tuple { M1, M2, M3, M4, M5, M6 } for the metrics defined above
  - Break each line to column 100
- ABSOLUTELY NOTHING ELSE.

## Follow-up

- When the users says "delete", delete the created file.
- When the users says "more", add more questions to the created file.
