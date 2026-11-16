package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

// Protocol 3 keeps upstream stream boundaries separate from repair requests.
// A terminal may arrive while its HTTP connection is still open.
type framedInput struct {
	in      *bufio.Reader
	pending []byte
	ended   bool
}

func (r *framedInput) next() error {
	var packet struct {
		Data  []byte `json:"data"`
		End   bool   `json:"end"`
		Error string `json:"error"`
	}
	if err := frame(r.in, &packet); err != nil {
		return errors.New("invalid upstream bridge frame")
	}
	if len(packet.Data) > 64<<10 || (packet.End && len(packet.Data) > 0) || (packet.Error != "" && !packet.End) {
		return errors.New("invalid upstream bridge frame")
	}
	r.pending, r.ended = packet.Data, packet.End
	if packet.Error != "" {
		return errors.New("BPS tool transport correction request failed")
	}
	return nil
}

func (r *framedInput) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for len(r.pending) == 0 {
		if r.ended {
			return 0, io.EOF
		}
		if err := r.next(); err != nil {
			return 0, err
		}
	}
	n := copy(p, r.pending)
	r.pending = r.pending[n:]
	return n, nil
}

func (r *framedInput) Close() error { return nil }

func (r *framedInput) drain() error {
	r.pending = nil
	for !r.ended {
		if err := r.next(); err != nil {
			return err
		}
		r.pending = nil
	}
	return nil
}

type framedOutput struct {
	mu  sync.Mutex
	enc *json.Encoder
}

func (w *framedOutput) control(value any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.enc.Encode(value)
}

func (w *framedOutput) Write(p []byte) (int, error) {
	n := 0
	for len(p) > 0 {
		size := min(len(p), 64<<10)
		if err := w.control(map[string]any{"kind": "data", "data": p[:size]}); err != nil {
			return n, err
		}
		n += size
		p = p[size:]
	}
	return n, nil
}
