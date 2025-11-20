### Write Test

Create comprehensive tests for a given component or feature, implementing them iteratively with
validation at each step.

## Steps

1. **Understand the Context**
   - Read relevant source files and existing test files
   - Identify patterns and conventions used in the codebase
   - Understand what needs to be tested

2. **Plan the Tests**
   - Focus on **depth over breadth** - thorough testing of realistic scenarios
   - Look for edge cases, error conditions, and integration patterns
   - For coordinators/orchestrators: focus on deadlock scenarios and phase coordination
   - Avoid contrived scenarios (e.g., nested queries that should use joins)

3. **Implement ONE Test at a Time**
   - Write a single test
   - Run type check: `pnpm run types:check`
   - Run the test: `pnpm exec vitest run <test-file-path>`
   - **Present results to the user** with:
     - Test description
     - Type check status (✅/❌)
     - Test status (✅/❌)
     - Brief explanation of what the test validates
   - **Wait for user approval** before proceeding to the next test

4. **Fix Issues as They Arise**
   - If type check fails: fix type errors
   - If test fails: understand WHY (this might reveal real issues!)
   - Explain the error and the fix

5. **Iterate**
   - After user approves, implement the next test
   - Repeat steps 3-4 until all planned tests are complete

## Rules

### General

- **Never skip the type check** - always run it before running tests
- **Always present results** - don't continue silently
- **Explain failures** - especially if they reveal design issues or edge cases
- **One test at a time** - no batch implementations

### Code Style

- Follow existing test file conventions
- Use proper TypeScript types (no `any`)
- Keep test setup DRY with helper functions
- Use clear, descriptive variable names
- Use MINIMAL mocking and stubbing
- Test both happy path and error cases
- Verify state changes and side effects

## Example Session Format

After implementing each test, present:

```
## Test N: [Description]

**Type Check:** ✅ Passing
**Test:** ✅ Passing

This test verifies:
- [Point 1]
- [Point 2]

**Result:** Message about what was learned or validated

---

Ready for the next test!
```

## When to Stop

- All planned tests are implemented and passing
- User indicates they're satisfied
- Coverage of the component/feature is comprehensive
