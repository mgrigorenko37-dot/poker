---
name: Artifact re-registration after GitHub import
description: Why `listArtifacts()` returns empty and workflows are missing right after importing a repo that already has artifacts/ dirs, and how to fix it.
---

After a project with existing `artifacts/<slug>/.replit-artifact/artifact.toml` files is imported (or re-imported) from GitHub, the system's artifact registry does not know about them yet: `listArtifacts()` returns `[]` and `.replit`'s `[workflows]` section is empty, even though the artifact directories and their `artifact.toml` are intact on disk.

**Why:** artifact registration is driven by an explicit registration step, not just file presence. A fresh import only carries the filesystem contents, not the registry state.

**How to apply:** Do not call `createArtifact()` again (it fails with `ARTIFACT_DIR_EXISTS` since the slug dir already exists). Instead, for each existing artifact, copy its `artifact.toml` to a sibling temp file unchanged and call `verifyAndReplaceArtifactToml({ tempFilePath, artifactTomlPath })`. This "touch" triggers re-registration: the artifact appears in `listArtifacts()` and its managed workflow(s) (e.g. `artifacts/<slug>: <service>`) get added to `.replit`, at which point `WorkflowsRestart` works normally.
