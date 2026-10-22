# bscraft mail

This branch keeps the deployed Bulwark Webmail 1.15.0 base at
`fc22f111efaefa837d1796864664935c12cbc7bd`.

Corporate addresses on `bslabs.tech` are presented as `bscraft.ru` in message
participants, subject/preview and decoded message bodies. Replies use the
canonical participant addresses. Search for a canonical address covers both
domains, including negated filters. Browser list snapshots receive the same
projection when restored.
Search excerpts containing a migrated address omit server highlight markers so
split address tokens remain readable. Parsed mail invitation cards show the
canonical participant addresses while their source ICS, event UID, participant
IDs and authentication results remain intact.

The projection does not update server mail objects, MIME blobs, Message-IDs,
thread IDs, attachments, authentication results or signature fields. Original
message downloads remain available. Outgoing JMAP mutation requests are passed
through; the server's existing canonical identities determine the sender.
When both domain aliases have sender identities, the client uses the existing
canonical identity and its real server ID. The legacy identity stays stored for
compatibility. Display names and compose signatures use the canonical domain.

Set `SOURCE_CODE_URL` to this repository and revision when deploying. The
upstream license and notices are retained. The build publishes a SHA-pinned
image and a recovery archive with independently hashable OCI blobs.

Rollback uses the preceding image digest with the same application data and
SSO configuration; no mailbox data rewrite or reverse migration is needed.
