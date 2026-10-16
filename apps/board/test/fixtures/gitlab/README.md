# GitLab API fixtures

Response shapes of the GitLab REST API v4 endpoints the provider (`src/git/gitlab.ts`) calls, in the order it
calls them: `GET /projects/:id/repository/commits/:sha` (commit.json), `GET /projects/:id/repository/files/:path/raw?ref=`
(the fake answers the base text as `text/plain`), `DELETE /projects/:id/repository/branches/:branch` (204, or 404
when the branch is new), `POST /projects/:id/repository/commits` with `branch`, `start_sha` and `actions`
(commit-created.json), `POST /projects/:id/merge_requests` (merge-request.json), and after a veto
`POST /projects/:id/merge_requests/:iid/notes` (note.json) and `PUT /projects/:id/merge_requests/:iid` with
`state_event: close` (merge-request.json with `state: closed`). Shapes follow the GitLab REST API documentation for
a sample project `acme/gtm-automations`; ids and shas are placeholders. `test/gitlab-fake.ts` replays them.
