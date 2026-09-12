# Archive migrations

The first published baseline is `../schema.sql`, database version 1.
There are no upgrades for unpublished development databases.

After publication, leave the baseline unchanged. Add numbered SQL
files such as `002_description.sql`, register their contents in
`../schema.ts`, and increment `archive_schema.version`. Do not put
transaction statements or `PRAGMA user_version` in migration SQL: the
runner owns both.

Each migration and version update commits atomically. A failed step
rolls back; successful earlier steps remain applied and retries resume
there. Migrations must preserve archived evidence. Queries never
migrate; use `omnirecall sync` to upgrade an older supported archive.

Database versions, adapter parser versions, and JSON response versions
are independent. Include an upgrade test with existing data, rollback
coverage, and build verification for every migration. The CLI build
copies this directory beside `schema.sql`.
