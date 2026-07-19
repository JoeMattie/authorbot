# Fixture: work-item-missing-annotation

Broken in exactly one way: the work item's `source_annotation_id` matches no annotation record in the repository.

Expected validator codes (see expected-errors.json): WORK_ITEM_REF_UNRESOLVED.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
