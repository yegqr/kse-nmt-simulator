---
description: How to push changes to GitHub safely
---
1. Verify what files have changed
```bash
git status
```

2. Add all modified files to the staging area
```bash
git add db.js public/admin.html public/exam.html public/finish.html server.js
```

3. Commit the changes with a descriptive message
```bash
git commit -m "Fix scoring, add answer persistence, and question export/import"
```

4. Push the changes to the main branch
```bash
git push origin main
```

> [!NOTE]
> The database file (`data/exam.db`) is already included in `.gitignore`, so it will NOT be pushed to GitHub. This keeps your production data safe on the server.
