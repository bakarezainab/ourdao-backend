# API compatibility policy

The REST API currently has one known consumer, `ourdao-frontend`, and is
served under the unversioned `/api` prefix. Within that prefix, changes are
**additive only**. New optional response fields, new endpoints, and new error
codes may be added without changing the path version. Consumers must ignore
fields they do not understand.

This policy avoids a second path for routine additions while there is one
coordinated consumer. A version is reserved for changes that the existing
frontend cannot safely accept.

The following changes are breaking and must not ship silently:

- removing or renaming a response field, or changing its meaning;
- changing a field's JSON type, including changing a decimal string to a
  number or changing whether a field may be `null`;
- changing a successful status code or an established error status code;
- making accepted input invalid by tightening validation, changing a default,
  or making an optional parameter required;
- removing an endpoint or changing its authentication requirements.

A breaking change requires a new path prefix such as `/api/v2`. The old and
new versions must run together for at least one published release and 90 days,
whichever is longer. The release notes must name the affected endpoints, show
the old and new shapes, and give the removal date. Security fixes may shorten
that window, but the release notes must explain why.

Backend changes that affect consumers must include a linked
`ourdao-frontend` issue or pull request. The frontend should accept an additive
field before it starts depending on it. For a versioned breaking change, the
frontend must migrate to the new path before the old path is removed.
