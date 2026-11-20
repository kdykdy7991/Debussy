import { AuroraPillTabs } from "../aurora/PillTabs.tsx";
import { navigate } from "../router.ts";
import { AdminAaasKeysPage } from "./aaas-keys-page.tsx";
import { AdminLegacyIntegrationPanel } from "./legacy-integration-panel.tsx";
import styles from "./orchestration-page.module.css";

export function AdminAccessPage({ integration }: { integration: boolean }): React.JSX.Element {
	return (
		<>
			<div className={styles.sectionNav}>
				<AuroraPillTabs
					ariaLabel="接入类型"
					value={integration ? "/access/integrations" : "/access"}
					onChange={navigate}
					items={[
						{ value: "/access", label: "API Key" },
						{ value: "/access/integrations", label: "旧 Integration" },
					]}
				/>
			</div>
			{integration ? <AdminLegacyIntegrationPanel key="access" management /> : <AdminAaasKeysPage />}
		</>
	);
}
