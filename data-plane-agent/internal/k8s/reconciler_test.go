package k8s

import (
	"context"
	"io"
	"log/slog"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func testReconciler() *Reconciler {
	return &Reconciler{
		Client: fake.NewSimpleClientset(),
		log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func TestNamespaceIsolation(t *testing.T) {
	cases := []struct {
		app, env, want string
	}{
		{"billing-api", "staging", "billing-api-staging"},
		{"billing-api", "prod", "billing-api-prod"},
		// Les majuscules et caractères interdits doivent être normalisés.
		{"Billing_API", "Prod", "billing-api-prod"},
		{"my.app", "dev", "my-app-dev"},
	}
	for _, c := range cases {
		got := Spec{AppName: c.app, Environment: c.env}.Namespace()
		if got != c.want {
			t.Errorf("Namespace(%q, %q) = %q, attendu %q", c.app, c.env, got, c.want)
		}
	}
}

func TestSanitizeRespecteRFC1123(t *testing.T) {
	// Un nom trop long doit être tronqué sous 63 caractères et ne jamais
	// finir par un tiret, sinon l'API Kubernetes rejette la ressource.
	long := ""
	for i := 0; i < 100; i++ {
		long += "a"
	}
	got := sanitize(long + "-")
	if len(got) > 63 {
		t.Errorf("longueur %d > 63", len(got))
	}
	if got[len(got)-1] == '-' {
		t.Error("le nom ne doit pas finir par un tiret")
	}
	if sanitize("") != "app" {
		t.Error("une chaîne vide doit produire un nom de repli")
	}
}

// Apply doit créer namespace + deployment + service, et rester idempotent :
// un second appel met à jour sans échouer.
func TestApplyEstIdempotent(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()
	spec := Spec{
		DeploymentID:  "dep-1",
		AppName:       "demo",
		Environment:   "staging",
		Image:         "nginx:alpine",
		Replicas:      2,
		ContainerPort: 80,
		Env:           map[string]string{"FOO": "bar"},
	}

	if err := r.Apply(ctx, spec); err != nil {
		t.Fatalf("premier Apply: %v", err)
	}

	ns := spec.Namespace()
	if _, err := r.Client.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{}); err != nil {
		t.Fatalf("namespace absent: %v", err)
	}
	dep, err := r.Client.AppsV1().Deployments(ns).Get(ctx, "demo", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("deployment absent: %v", err)
	}
	if *dep.Spec.Replicas != 2 {
		t.Errorf("replicas = %d, attendu 2", *dep.Spec.Replicas)
	}
	if _, err := r.Client.CoreV1().Services(ns).Get(ctx, "demo", metav1.GetOptions{}); err != nil {
		t.Fatalf("service absent: %v", err)
	}

	// Redéploiement avec une nouvelle image.
	spec.Image = "nginx:1.27"
	spec.DeploymentID = "dep-2"
	if err := r.Apply(ctx, spec); err != nil {
		t.Fatalf("second Apply: %v", err)
	}
	dep, err = r.Client.AppsV1().Deployments(ns).Get(ctx, "demo", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got := dep.Spec.Template.Spec.Containers[0].Image; got != "nginx:1.27" {
		t.Errorf("image = %q, attendu nginx:1.27", got)
	}
}

// Le selector d'un Deployment est immuable : il ne doit pas contenir le
// deployment-id, qui change à chaque déploiement.
func TestSelectorNeContientPasLeDeploymentID(t *testing.T) {
	r := testReconciler()
	spec := Spec{DeploymentID: "dep-1", AppName: "demo", Environment: "staging"}
	if _, ok := r.selectorLabels(spec)[LabelDeployment]; ok {
		t.Error("le selector ne doit pas inclure le label deployment-id")
	}
	if _, ok := r.labels(spec)[LabelDeployment]; !ok {
		t.Error("les labels de ressource doivent inclure le deployment-id")
	}
}

func TestIngressCreeUniquementSiHost(t *testing.T) {
	ctx := context.Background()

	r := testReconciler()
	spec := Spec{AppName: "demo", Environment: "staging", Image: "nginx", Replicas: 1, ContainerPort: 80}
	if err := r.Apply(ctx, spec); err != nil {
		t.Fatal(err)
	}
	list, _ := r.Client.NetworkingV1().Ingresses(spec.Namespace()).List(ctx, metav1.ListOptions{})
	if len(list.Items) != 0 {
		t.Error("aucun Ingress ne doit être créé sans host")
	}

	r2 := testReconciler()
	spec.Host = "demo.exemple.fr"
	spec.TLS = true
	if err := r2.Apply(ctx, spec); err != nil {
		t.Fatal(err)
	}
	ing, err := r2.Client.NetworkingV1().Ingresses(spec.Namespace()).Get(ctx, "demo", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("ingress absent: %v", err)
	}
	if ing.Spec.Rules[0].Host != "demo.exemple.fr" {
		t.Errorf("host = %q", ing.Spec.Rules[0].Host)
	}
	if len(ing.Spec.TLS) == 0 {
		t.Error("la section TLS doit être renseignée quand TLS est demandé")
	}
	if ing.Annotations["cert-manager.io/cluster-issuer"] == "" {
		t.Error("l'annotation cert-manager est attendue")
	}
}

// Sur un hostname non maîtrisé (nip.io), demander un certificat bloquerait
// l'Ingress : cert-manager ne peut pas valider le challenge.
func TestIngressSansTLS(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	spec := Spec{
		AppName: "demo", Environment: "staging", Image: "nginx",
		Replicas: 1, ContainerPort: 80,
		Host: "demo-staging.10.0.0.1.nip.io",
		TLS:  false,
	}
	if err := r.Apply(ctx, spec); err != nil {
		t.Fatal(err)
	}

	ing, err := r.Client.NetworkingV1().Ingresses(spec.Namespace()).Get(ctx, "demo", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("ingress absent: %v", err)
	}
	// L'Ingress doit exister et router, mais sans bloc TLS.
	if ing.Spec.Rules[0].Host != spec.Host {
		t.Errorf("host = %q", ing.Spec.Rules[0].Host)
	}
	if len(ing.Spec.TLS) != 0 {
		t.Error("aucune section TLS ne doit être créée sans domaine maîtrisé")
	}
	if ing.Annotations["cert-manager.io/cluster-issuer"] != "" {
		t.Error("cert-manager ne doit pas être sollicité")
	}
}
