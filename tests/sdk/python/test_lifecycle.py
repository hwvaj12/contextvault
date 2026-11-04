def test_binary_directories_deletion_tenant_isolation_and_abort(consumer):
    consumer("lifecycle")


def test_stale_conflict_lease_expiry_and_failed_cleanup(consumer):
    consumer("failures")


def test_filesystem_policy_and_canonical_manifest(consumer):
    consumer("filesystem")


def test_bounded_binary_empty_unicode_and_corrupt_download_recovery(consumer):
    consumer("binary_streams")
