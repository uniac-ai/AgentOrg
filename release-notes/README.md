# Release notes

Each release's notes go here, as `release-notes/v<version>.md` (for example
`release-notes/v0.0.31.md`), added in the release's PR. The release workflow makes the tag's GitHub
release with them. A tag whose notes are missing or empty stops before anything is published: add
them, then move the tag: delete it and push it again.

`@agentorg/sdk` is released apart, from a tag `sdk-v<version>`: its notes are
`release-notes/sdk-v<version>.md` (for example `release-notes/sdk-v0.0.1.md`), and its own release
workflow, `release-sdk.yml`, makes its GitHub release with them in the same way.
