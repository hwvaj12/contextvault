def test_lost_response_restart_before_remote_ids(consumer):
    consumer("identity_recovery")


def test_original_immutable_capture_and_uncertain_authorization(consumer):
    consumer("publication_recovery")


def test_dispatch_crash_retains_uncertainty_before_remote_id(consumer):
    consumer("dispatch_crash")


def test_known_failed_operation_is_distinct_from_unknown(consumer):
    consumer("known_failed_reconciliation")


def test_incomplete_hydration_resumes_after_process_crash(consumer):
    consumer("hydration_restart")


def test_polling_authorization_failure_remains_unknown(consumer):
    consumer("polling_authorization")
