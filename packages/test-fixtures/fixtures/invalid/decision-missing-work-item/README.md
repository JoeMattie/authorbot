# Fixture: decision-missing-work-item

Broken in exactly one way: the decision's `work_item_id` matches no work item in the repository.

Expected validator codes (see expected-errors.json): DECISION_REF_UNRESOLVED.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
