def test_sequential_checkpoints_and_reopen_recovery(consumer):
    consumer("checkpoint")


def test_legacy_local_wrappers_and_readonly_checkpoint(consumer):
    consumer("compatibility_wrappers")
