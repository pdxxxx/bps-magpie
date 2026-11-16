// bps-bridge performs local protocol conversion only. Credentials and network
// operations stay in the Magpie plugin host, including its proxy context.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"

	"github.com/pdxxxx/bps-magpie/bridge/internal/basispoints"
)

const maxFrame = 128 << 20

func frame(in *bufio.Reader, target any) error {
	var data []byte
	for {
		part, more, err := in.ReadLine()
		if err != nil {
			return err
		}
		if len(data)+len(part) > maxFrame {
			return errors.New("bridge request exceeds 128 MiB")
		}
		data = append(data, part...)
		if !more {
			break
		}
	}
	return json.Unmarshal(data, target)
}

func run(in *bufio.Reader, out io.Writer) error {
	var request struct {
		Raw         []byte `json:"raw"`
		Scope       string `json:"scope"`
		Compact     bool   `json:"compact"`
		Previous    []byte
		Terminal    []byte
		Catalog     []byte
		KeepContext bool
	}
	if err := frame(in, &request); err != nil {
		return errors.New("invalid bridge request")
	}
	if len(request.Raw) > 64<<20 {
		return errors.New("request exceeds 64 MiB")
	}
	var err error
	request.Raw, err = expandContinuation(request.Raw, request.Previous, request.Terminal)
	if err != nil {
		return err
	}
	// Default compatibility applies to expanded history before caching, compaction
	// or uploads. The adapter preserves opaque reasoning/compaction state and
	// rejects unreadable current tasks instead of silently discarding them.
	request.Raw, err = basispoints.StripEncryptedContent(request.Raw)
	if err != nil {
		return err
	}
	snapshot := []byte{}
	if request.KeepContext {
		snapshot, err = contextSnapshot(request.Raw, request.Compact)
		if err != nil {
			return err
		}
		if len(snapshot) > 4<<20 {
			snapshot = []byte{}
		}
	}
	if request.Compact {
		var err error
		request.Raw, err = compactRequest(request.Raw)
		if err != nil {
			return err
		}
	}
	plan, err := basispoints.PrepareNativeImages(request.Raw)
	if err != nil {
		return err
	}
	var replay basispoints.ReplayCache
	if len(request.Catalog) > 1<<20 || (len(request.Catalog) > 0 && (!json.Valid(request.Catalog) || request.Catalog[0] != '[')) {
		return errors.New("invalid inherited tool catalog")
	}
	state := &requestCatalog{scope: request.Scope, raw: request.Catalog}
	_, catalog := basispoints.NewPersistentCaches(context.Background(), state)
	// Validate the entire request, tool catalog and images before any upload.
	body, bridge, err := plan.PrepareWithCatalog(request.Scope, &replay, catalog)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(out)
	var attachments basispoints.AttachmentCache
	uploaded, err := plan.Upload(context.Background(), &attachments, request.Scope, func(ctx context.Context, a basispoints.InlineAttachment) (string, error) {
		body, contentType, _, err := a.Multipart()
		if err != nil {
			return "", err
		}
		raw, err := io.ReadAll(io.LimitReader(body, 24<<20))
		if err != nil {
			return "", err
		}
		if err = enc.Encode(map[string]any{"kind": "upload", "body": raw, "contentType": contentType}); err != nil {
			return "", err
		}
		var answer struct {
			ID    string `json:"id"`
			Error string `json:"error"`
		}
		if err = frame(in, &answer); err != nil {
			return "", err
		}
		if answer.Error != "" {
			return "", errors.New("attachment upload failed")
		}
		return answer.ID, nil
	})
	if err != nil {
		return err
	}
	if plan.HasImages() {
		body, bridge, err = bridge.Reprepare(uploaded)
		if err != nil {
			return err
		}
	}
	if err = enc.Encode(map[string]any{"kind": "request", "protocol": 2, "body": body, "context": snapshot, "catalog": state.raw, "effort": bridge.Effort, "warnings": bridge.Warnings}); err != nil {
		return err
	}
	// The remaining stdin bytes are the upstream SSE body. Native tools are
	// withheld until the imported bridge validates the entire terminal batch.
	stream := bridge.Stream(io.NopCloser(in))
	defer stream.Close()
	if _, err = io.Copy(out, stream); err != nil {
		return errStream
	}
	return nil
}

var errStream = errors.New("BPS stream did not complete")
var version = "development"

func main() {
	if len(os.Args) > 1 {
		if len(os.Args) == 2 && os.Args[1] == "--version" {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"version": version, "protocol": 2})
			return
		}
		os.Exit(2)
	}
	if err := run(bufio.NewReaderSize(os.Stdin, 64<<10), os.Stdout); err != nil {
		// Never print payloads or tokens. Once SSE has started the bridge supplies
		// its own failure event; exit status also prevents silent truncation.
		if !errors.Is(err, errStream) {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"kind": "error", "message": err.Error()})
		}
		os.Exit(1)
	}
}
