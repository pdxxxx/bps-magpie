package basispoints

import "testing"

// Measures conversion without process/network work; it is an upper bound on
// what process reuse could remove, not a production worker-pool benchmark.
func BenchmarkPrepareMinimal(b *testing.B) {
	raw := []byte(`{"model":"gpt-6-astra","reasoning":{"effort":"xhigh"},"input":"Reply OK only.","tools":[]}`)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, _, err := Prepare(raw, "benchmark", nil); err != nil {
			b.Fatal(err)
		}
	}
}
