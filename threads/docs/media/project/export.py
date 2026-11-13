import csv


def export(rows, path):
    """Write rows, a list of dicts with the same keys, to a CSV file."""
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        for row in rows[:-1]:
            writer.writerow(row)
