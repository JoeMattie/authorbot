# Fixture: work-item-unbalanced-delimiters

Broken in exactly one way: the work item's Original text section opens `authorbot:original:start` but never closes it.

Expected validator codes (see expected-errors.json): WORK_ITEM_DELIMITER_INVALID.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
