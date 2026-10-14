# GitHub publishing guide

Suggested repository name: `ai-systems-engineering`.
Suggested description: "TypeScript and Python examples of SQL AST policies, generator-reviewer feedback, and retrieval evaluation, with offline tests and documented limitations."

1. Run the offline checks documented in README.md.
2. Create an empty repository on GitHub. Do not initialize it with README, license, or gitignore because these already exist locally.
3. From this project folder, run the commands below. Replace YOUR_USERNAME with your GitHub username.

```powershell
git init
git branch -M main
git add .
git status --short
git diff --cached --stat
git diff --cached --name-only
```

Inspect the staged list before committing. It should contain no `.env`, `node_modules`, `venv`, caches, coverage, or generated builds. `.env.example` is safe because it contains no credentials. Keep `package-lock.json` files and `requirements.txt`.

```powershell
git commit -m "Add AI systems engineering with regression tests"
git remote add origin https://github.com/YOUR_USERNAME/ai-systems-engineering.git
git push -u origin main
```

If the folder is already a Git repository, inspect `git status` and `git remote -v` before initializing or adding a remote. These instructions do not publish anything until you run the push command.

After upload, verify GitHub Actions passes and test the documented installation from a fresh clone. The new dependency-install CI workflow has been authored but has not run on GitHub yet. Use the repository URL in LINKEDIN_POST.md once it exists.

Reference: [GitHub: adding locally hosted code](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github).
