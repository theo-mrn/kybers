{{- define "kybers-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kybers-agent.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "kybers-agent.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kybers-agent.labels" -}}
app.kubernetes.io/name: {{ include "kybers-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "kybers-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kybers-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kybers-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kybers-agent.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "kybers-agent.secretName" -}}
{{- if .Values.auth.existingSecret -}}
{{- .Values.auth.existingSecret -}}
{{- else -}}
{{- include "kybers-agent.fullname" . -}}
{{- end -}}
{{- end -}}
