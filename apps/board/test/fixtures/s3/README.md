# S3 fixtures

Responses of a MinIO server (`quay.io/minio/minio`, the docker compose one) to the calls the object store
(`src/storage/s3.ts`) makes, recorded on 2026-09-13 against a throwaway bucket with the store's own client,
in the order they happened: `PUT /bucket/key` before the bucket existed (put-object-no-bucket.json,
`NoSuchBucket`), `PUT /bucket/` (create-bucket.json), `PUT /bucket/key` again (put-object.json),
`GET /bucket/key` (get-object.json; the body is the object's bytes, which the fake serves from what was put)
and `GET` of a key that does not exist (get-object-missing.json, `NoSuchKey`). Request ids and dates are
whatever MinIO answered; nothing in a response is a credential. `test/s3-fake.ts` replays them and checks
each request's SigV4 authorization line and payload hash the way the server would.

Re-record against the MinIO from `pnpm db:up` (or any S3-compatible store in `apps/board/.env`) with:

```bash
cd apps/board && node --env-file=.env --import tsx scripts/record-s3-fixtures.mts
```

The signer itself is checked against the two worked examples in the AWS documentation for Signature
Version 4 with S3 (GET Object with a Range header, PUT Object with a storage class), whose expected
signatures are public.
