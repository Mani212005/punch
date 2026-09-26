Tiny offline fixture repos for the validation sandbox tests. The dependency is a local
`file:` package, so the upgrade needs no registry: `greeter@file:./vendor/greeter-2`.
`pass-repo` v2 is compatible; `break-repo` v2 changes greeting output and breaks two tests.
