#!/bin/bash
# Works in a checkout's review-desk/ folder and at the downloaded bundle root.
set -u

review_desk_dir="$(cd -- "$(dirname -- "$0")" && pwd)" || exit 1
if [ -f "$review_desk_dir/review-desk/app.py" ]; then
    review_desk_dir="$review_desk_dir/review-desk"
fi
cd -- "$review_desk_dir" || exit 1

if [ ! -f app.py ]; then
    echo "The review app is missing. Extract the complete ZIP before starting it."
    read -r -p "Press Return to close. " review_desk_reply
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "This app needs Python 3.10 or newer. Install it from https://www.python.org/downloads/ and open this launcher again."
    read -r -p "Press Return to close. " review_desk_reply
    exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
    echo "This app needs Python 3.10 or newer. Install it from https://www.python.org/downloads/ and open this launcher again."
    read -r -p "Press Return to close. " review_desk_reply
    exit 1
fi

echo "Starting Uptight Review Desk on this computer. Keep this window open while reviewing."
python3 app.py "$@"
review_desk_status=$?
if [ "$review_desk_status" -ne 0 ]; then
    read -r -p "The app stopped. Press Return to close this window. " review_desk_reply
fi
exit "$review_desk_status"
