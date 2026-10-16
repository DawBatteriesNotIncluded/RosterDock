# Kubernetes fixtures

The API server's answers for the Secret operations the board's secret store makes
(`src/secrets/kubernetes.ts`): a GET that finds nothing (`secret-missing`), a POST that creates
(`secret-created`), a GET that finds it (`secret-get`), a PUT that replaces it (`secret-replaced`), a
POST for a name that exists (`secret-conflict`), a DELETE (`secret-deleted`, a Status of Success) and a
DELETE of nothing (`secret-delete-missing`); and the two refusals, a service account without the Role
(`secret-forbidden`) and a bad token (`unauthorized`).

Written from the Kubernetes API reference (v1.34: the `Secret` object and the `Status` object with
`reason` NotFound, AlreadyExists, Forbidden and Unauthorized) with placeholder names, ids and values;
the chat that added the store was not permitted to create Secrets on the local cluster to record them.
`scripts/record-kubernetes.mjs` records the same files through `kubectl proxy` against a throwaway
namespace when that is allowed. `test/k8s-fake.ts` replays them over an injected fetch, substitutes the
name asked for, keeps what was put so a GET returns it, and checks the bearer and the namespace.
