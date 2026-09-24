You are implementing Azure DevOps User Story {{WORK_ITEM_ID}}.

Repository:
{{REPO_NAME}}

{{ALL_REPOS_CONTEXT}}

Work item branch (must be used):
{{WORK_ITEM_BRANCH}}

Title:
{{TITLE}}

Description:
{{DESCRIPTION}}

Acceptance Criteria:
{{ACCEPTANCE_CRITERIA}}

{{TECH_STACK}}

{{CODE_CONTEXT}}

{{IMPLEMENTATION_PLAN}}

Execution mode:
- You are running in a non-interactive automation worker.
- Do not ask clarifying questions.
- Do not request additional input from a user.
- If details are ambiguous or missing, make reasonable implementation assumptions and proceed.
- Document the plan into a markdown file IMPLEMENTATION_FOR_<workitem id>.md
- Do not stop after producing a plan. Implement the code changes immediately.
- Do not ask for plan review or approval. Continue through implementation and commit in one run.
- Capture key assumptions in code comments where appropriate.

Constraints:
- Follow repository architecture and conventions
- Minimize unrelated changes
- Add or update unit tests where applicable
- Use the build and test commands from TECHSTACK.md if present; otherwise infer from the project structure
- Write tests compatible with the framework listed in TECHSTACK.md (or detected from the repo)
- Keep commit scope aligned to this work item
- Commit all changes (implementation + tests) to the work item branch

Output expectations:
- Implement required code changes
- Add comprehensive test coverage for changed behavior
- Commit all changes to the work item branch with a descriptive commit message
- **Do NOT run tests yourself** - the automation worker will run tests after you complete
- **Do NOT create pull requests** - the automation worker will create the PR after tests pass
- **Do NOT push to origin** - the automation worker will push the branch after verification
- Leave the repository with all changes committed locally

IMPORTANT: Your job is to implement the code and tests, then commit them. The automation worker will handle:
1. Running the test suite (Maven, Gradle, npm test, pytest, etc.)
2. Validating code coverage
3. Pushing the branch to origin
4. Creating the pull request in Azure DevOps

If you cannot run tests or create PRs, that is expected and correct. Simply implement, test, and commit.




