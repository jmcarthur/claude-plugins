from datetime import datetime


def parse(text):
    """Parse an order's timestamp, such as '2024-03-09 14:05'."""
    for fmt in ("%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    raise ValueError(f"unknown timestamp: {text}")
