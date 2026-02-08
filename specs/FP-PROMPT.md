1. use the $fragno-spec-implement skill to find and claim a todo issue (fp tree / fp issue list)
2. follow the process in the skill reference. Implement a part of the spec.
3. after ALL tests pass, lint checks and types check, commit and push
4. Use skill $fragno-commit to commit the changes.
5. After commit, assign the commit to the issue (`fp issues assign <id> --ref <commit-hash>`).
6. make sure to mark the issue as done when you finish it (fp issue update --status done <ID>)
7. when ALL issues are finished (all have status "done"), write only:
   <promise>TASKS_FINISHED</promise>
