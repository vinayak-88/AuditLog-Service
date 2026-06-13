import { VerificationResult } from '../../../components/VerificationResult';

export default function VerifyPage() {
  return (
    <div className="grid">
      <div className="topbar">
        <h1 className="page-title">Verify</h1>
      </div>
      <VerificationResult />
    </div>
  );
}
