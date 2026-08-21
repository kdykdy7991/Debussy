"""Dijkstra shortest path: adjacency list + binary heap."""
import heapq


def dijkstra(edges, start, end):
    """edges: iterable of (u, v, w) for an undirected graph.

    Returns (distance, path) or None if end is unreachable.
    """
    adj = {}
    for u, v, w in edges:
        adj.setdefault(u, []).append((v, w))
        adj.setdefault(v, []).append((u, w))

    dist = {start: 0}
    prev = {}
    done = set()
    pq = [(0, start)]
    while pq:
        d, u = heapq.heappop(pq)
        if u in done:
            continue
        done.add(u)
        if u == end:
            break
        for v, w in adj.get(u, ()):
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))

    if end not in dist:
        return None
    path = [end]
    while path[-1] != start:
        path.append(prev[path[-1]])
    return dist[end], path[::-1]


if __name__ == "__main__":
    edges = [
        ("A", "B", 4), ("A", "C", 1), ("B", "C", 2),
        ("B", "D", 5), ("C", "D", 8), ("C", "E", 10),
        ("D", "E", 3),
    ]
    print(dijkstra(edges, "A", "E"))
